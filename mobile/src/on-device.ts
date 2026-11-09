import { useEffect, useRef, useState } from 'react';
import { isParakeetLanguage, languageBase } from './languages';
import { speech, checkedLocalLanguage } from './native-speech';

export type LocalModelState =
  | { kind: 'unavailable' | 'checking' | 'missing' | 'ready' }
  | { kind: 'downloading' | 'installing'; fraction: number }
  | { kind: 'error'; message: string };

export function localModelKey(language: string): 'english' | 'multilingual' {
  return languageBase(language) === 'en' ? 'english' : 'multilingual';
}

export async function transcribeOnDevice(uri: string, signal: AbortSignal, language: string): Promise<string> {
  signal.throwIfAborted();
  if (!speech) throw new Error('On-device Parakeet requires the updated native app build.');
  const selected = checkedLocalLanguage(language);
  if (await speech.getModelState(selected) !== 'ready') throw new Error('Download Parakeet for the selected language in Settings first.');
  signal.throwIfAborted();
  let text: string;
  try { text = await speech.transcribe(uri, selected); }
  catch { throw new Error('Parakeet could not transcribe this recording. Try a shorter recording, or restart the app.'); }
  signal.throwIfAborted();
  return text;
}

/** preloadLanguage prepares that language's installed model in the background; null skips preparation. */
export function useOnDeviceModel(preloadLanguage: string | null) {
  const initial: LocalModelState = { kind: speech ? 'checking' : 'unavailable' };
  const [localModels, setModels] = useState<Record<'english' | 'multilingual', LocalModelState>>({ english: initial, multilingual: initial });
  const setModel = (key: 'english' | 'multilingual', state: LocalModelState) => setModels(models => ({ ...models, [key]: state }));
  const mounted = useRef(false);
  const installing = useRef<'english' | 'multilingual' | null>(null);
  const prepared = useRef<'english' | 'multilingual' | null>(null);
  const [preparingModel, setPreparingModel] = useState(false);
  useEffect(() => {
    mounted.current = true;
    const subscription = speech?.addListener('onModelProgress', progress => {
      if (mounted.current && installing.current && Number.isFinite(progress.fraction) &&
          (progress.phase === 'downloading' || progress.phase === 'installing')) {
        setModel(installing.current, { kind: progress.phase, fraction: Math.max(0, Math.min(1, progress.fraction)) });
      }
    });
    for (const language of ['en', '']) {
      const key = localModelKey(language);
      void speech?.getModelState(language).then(kind => {
        if (mounted.current && installing.current !== key) setModel(key, { kind });
      }).catch(() => {
        if (mounted.current && installing.current !== key) setModel(key, { kind: 'error', message: 'Could not check the local model. Try downloading it again.' });
      });
    }
    return () => { mounted.current = false; subscription?.remove(); };
  }, []);

  const preloadKey = preloadLanguage === null ? null : localModelKey(preloadLanguage);
  const preloadReady = preloadKey !== null && localModels[preloadKey].kind === 'ready';
  useEffect(() => {
    const nativeSpeech = speech;
    if (preloadLanguage === null || !isParakeetLanguage(preloadLanguage) || !preloadReady || !nativeSpeech || prepared.current === preloadKey) return;
    prepared.current = preloadKey;
    setPreparingModel(true);
    // Preparation shares native's existing load task; it never downloads or opens the microphone.
    void Promise.resolve().then(() => nativeSpeech.prepareModel(checkedLocalLanguage(preloadLanguage))).catch(() => {
      // A session or transcription retries preparation and reports failure when explicitly requested.
      prepared.current = null;
    }).finally(() => {
      if (mounted.current) setPreparingModel(false);
    });
  }, [preloadLanguage, preloadKey, preloadReady]);

  const installLocalModel = async (language: string) => {
    if (!speech || installing.current) return;
    const selected = checkedLocalLanguage(language);
    const key = localModelKey(selected);
    installing.current = key;
    setModel(key, { kind: 'downloading', fraction: 0 });
    try {
      await speech.installModel(selected);
      if (mounted.current) setModel(key, { kind: 'ready' });
    } catch {
      if (mounted.current) setModel(key, { kind: 'error', message: 'Parakeet could not be downloaded or loaded. Check your connection and free storage, then retry.' });
    } finally { installing.current = null; }
  };
  return { localModels, installLocalModel, preparingModel };
}
