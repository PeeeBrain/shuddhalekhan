import { useEffect, useRef, useState } from 'react';
import { requireOptionalNativeModule } from 'expo';
import { isParakeetLanguage, languageBase } from './languages';

type Progress = { phase: 'downloading' | 'installing'; fraction: number };
type NativeSpeech = {
  getModelState(language: string): Promise<'missing' | 'ready'>;
  prepareModel(language: string): Promise<void>;
  installModel(language: string): Promise<void>;
  transcribe(uri: string, language: string): Promise<string>;
  signGoogleJwt(privateKey: string, input: string): Promise<string>;
  getKeyboardSession(): Promise<NativeKeyboardSession>;
  startKeyboardSession(minutes: number, language: string): Promise<NativeKeyboardSession>;
  stopKeyboardSession(): Promise<void>;
  addListener(event: 'onModelProgress', listener: (progress: Progress) => void): { remove(): void };
  addListener(event: 'onKeyboardSession', listener: (session: NativeKeyboardSession) => void): { remove(): void };
};
/** endsAt is epoch ms, 0 when no session; error explains why native ended a session early. */
type NativeKeyboardSession = { endsAt: number; phase: string; error?: string };

export type LocalModelState =
  | { kind: 'unavailable' | 'checking' | 'missing' | 'ready' }
  | { kind: 'downloading' | 'installing'; fraction: number }
  | { kind: 'error'; message: string };

const speech = requireOptionalNativeModule<NativeSpeech>('ShuddhalekhanSpeech');

export function localModelKey(language: string): 'english' | 'multilingual' {
  return languageBase(language) === 'en' ? 'english' : 'multilingual';
}

function checkedLocalLanguage(language: string): string {
  if (!isParakeetLanguage(language)) throw new Error('Parakeet does not support this language. Choose a supported language or use an endpoint.');
  return languageBase(language);
}

export async function signGoogleJwt(privateKey: string, input: string): Promise<string> {
  if (!speech) throw new Error('Google service-account authentication requires the updated native app build.');
  try { return await speech.signGoogleJwt(privateKey, input); }
  catch { throw new Error('Could not sign with this Google service-account key. Check its private key.'); }
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
    if (preloadLanguage === null || !isParakeetLanguage(preloadLanguage) || !preloadReady || !speech || prepared.current === preloadKey) return;
    prepared.current = preloadKey;
    setPreparingModel(true);
    // Preparation shares native's existing load task; it never downloads or opens the microphone.
    void Promise.resolve().then(() => speech.prepareModel(checkedLocalLanguage(preloadLanguage))).catch(() => {
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

export const keyboardSessionMinutes = 10;

/**
 * Native owns the keyboard session (mic, timer, Parakeet) so it keeps working while this JS is in the
 * background; React only mirrors it for the countdown and the Start/Stop controls.
 */
export function useKeyboardSession() {
  const [session, setSession] = useState<NativeKeyboardSession>({ endsAt: 0, phase: 'idle' });
  const [now, setNow] = useState(Date.now);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    const subscription = speech?.addListener('onKeyboardSession', setSession);
    void speech?.getKeyboardSession().then(setSession).catch(() => {});
    return () => subscription?.remove();
  }, []);
  const active = session.endsAt !== 0;
  useEffect(() => {
    if (session.endsAt === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session.endsAt]);

  const startKeyboardSession = async (language: string) => {
    if (!speech || starting) return;
    setStarting(true);
    const selected = checkedLocalLanguage(language);
    try { setSession(await speech.startKeyboardSession(keyboardSessionMinutes, selected)); }
    catch { throw new Error('Could not start the keyboard session. Check microphone access and that Parakeet is downloaded, then try again.'); }
    finally { setStarting(false); }
  };
  return {
    keyboardSession: {
      available: speech !== null, active, starting,
      // Native may hold the session past zero while a started utterance finishes.
      remainingSeconds: Math.max(0, Math.ceil((session.endsAt - now) / 1000)),
      busy: session.phase === 'recording' || session.phase === 'transcribing',
      endedReason: session.endsAt === 0 ? session.error ?? null : null,
    },
    startKeyboardSession,
    stopKeyboardSession: async () => { await speech?.stopKeyboardSession(); },
  };
}
