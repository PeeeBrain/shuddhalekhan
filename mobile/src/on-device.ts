import { useEffect, useRef, useState } from 'react';
import { requireOptionalNativeModule } from 'expo';

type Progress = { phase: 'downloading' | 'installing'; fraction: number };
type NativeSpeech = {
  getModelState(): Promise<'missing' | 'ready'>;
  installModel(): Promise<void>;
  transcribe(uri: string): Promise<string>;
  getKeyboardSession(): Promise<NativeKeyboardSession>;
  startKeyboardSession(minutes: number): Promise<NativeKeyboardSession>;
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

export async function transcribeOnDevice(uri: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!speech) throw new Error('On-device Parakeet requires the updated native app build.');
  if (await speech.getModelState() !== 'ready') throw new Error('Download Parakeet in Settings first.');
  signal.throwIfAborted();
  let text: string;
  try { text = await speech.transcribe(uri); }
  catch { throw new Error('Parakeet could not transcribe this recording. Try a shorter recording, or restart the app.'); }
  signal.throwIfAborted();
  return text;
}

export function useOnDeviceModel() {
  const [localModel, setModel] = useState<LocalModelState>({ kind: speech ? 'checking' : 'unavailable' });
  const mounted = useRef(false);
  const installing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const subscription = speech?.addListener('onModelProgress', progress => {
      if (mounted.current && installing.current && Number.isFinite(progress.fraction) &&
          (progress.phase === 'downloading' || progress.phase === 'installing')) {
        setModel({ kind: progress.phase, fraction: Math.max(0, Math.min(1, progress.fraction)) });
      }
    });
    void speech?.getModelState().then(kind => {
      if (mounted.current && !installing.current) setModel({ kind });
    }).catch(() => {
      if (mounted.current && !installing.current) setModel({ kind: 'error', message: 'Could not check the local model. Try downloading it again.' });
    });
    return () => { mounted.current = false; subscription?.remove(); };
  }, []);

  const installLocalModel = async () => {
    if (!speech || installing.current) return;
    installing.current = true;
    setModel({ kind: 'downloading', fraction: 0 });
    try {
      await speech.installModel();
      if (mounted.current) setModel({ kind: 'ready' });
    } catch {
      if (mounted.current) setModel({ kind: 'error', message: 'Parakeet could not be downloaded or loaded. Check your connection and free storage, then retry.' });
    } finally { installing.current = false; }
  };
  return { localModel, installLocalModel };
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

  const startKeyboardSession = async () => {
    if (!speech || starting) return;
    setStarting(true);
    try { setSession(await speech.startKeyboardSession(keyboardSessionMinutes)); }
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
