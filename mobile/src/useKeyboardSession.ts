import { useEffect, useState } from 'react';
import { keyboardSessionSchema, type KeyboardSessionEvent } from './keyboard-session';
import { speech, checkedLocalLanguage } from './native-speech';

const keyboardSessionMinutes = 10;

/**
 * Native owns the keyboard session (mic, timer, Parakeet) so it keeps working while this JS is in the
 * background. Agent handoffs are handled directly in the native listener, independently of rendering.
 */
export function useKeyboardSession(onSession: (event: KeyboardSessionEvent) => Promise<void>) {
  const [session, setSession] = useState<KeyboardSessionEvent>({ endsAt: 0, phase: 'idle', agentReady: false });
  const [now, setNow] = useState(Date.now);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    let handedOff: string | undefined;
    const receive = (value: unknown) => {
      const parsed = keyboardSessionSchema.safeParse(value);
      if (!parsed.success) return;
      const event = parsed.data;
      setSession(event);
      if (event.mode === 'agent' && event.phase === 'done' && event.requestId) {
        if (handedOff === event.requestId) return;
        handedOff = event.requestId;
        const id = event.requestId;
        void onSession(event).then(
          () => speech?.resolveKeyboardAgentRequest(id, null),
          error => speech?.resolveKeyboardAgentRequest(id, error instanceof Error ? error.message : 'The agent could not start.'),
        ).catch(() => {});
      } else { void onSession(event).catch(() => {}); }
    };
    // A listener event is newer than the initial read; a late snapshot must not overwrite it.
    let heard = false;
    const subscription = speech?.addListener('onKeyboardSession', (value: unknown) => { heard = true; receive(value); });
    void speech?.getKeyboardSession().then(value => { if (!heard) receive(value); }).catch(() => {});
    return () => subscription?.remove();
  }, [onSession]);
  const active = session.endsAt !== 0;
  useEffect(() => {
    if (session.endsAt === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session.endsAt]);

  // `starting` is claimed before the first await so in-app recording stays disabled while the session prepares.
  const startKeyboardSession = async (language: string, agentReady: () => Promise<boolean>) => {
    if (!speech || starting) return;
    const selected = checkedLocalLanguage(language);
    setStarting(true);
    try {
      const ready = await agentReady();
      setSession(keyboardSessionSchema.parse(await speech.startKeyboardSession(keyboardSessionMinutes, selected, ready)));
    } catch { throw new Error('Could not start the keyboard session. Check microphone access and that Parakeet is downloaded, then try again.'); }
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
