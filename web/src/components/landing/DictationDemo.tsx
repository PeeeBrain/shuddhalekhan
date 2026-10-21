import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Mic } from 'lucide-react';
import { RecordingPill } from '@/components/landing/Pill';

/* What was heard (fillers flagged) and what lands at the cursor. Only the
   app's real filler list is stripped: um, uh, ah, er, hmm. */
const PHRASES: { heard: [string, boolean][]; typed: string }[] = [
  {
    heard: [['Um, ', true], ['the installer is ready. ', false], ['Uh, ', true], ['we can ship it tomorrow.', false]],
    typed: 'The installer is ready. We can ship it tomorrow.',
  },
  {
    heard: [['Can you move the standup to, ', false], ['uh, ', true], ['ten thirty?', false]],
    typed: 'Can you move the standup to ten thirty?',
  },
  {
    heard: [['Hmm, ', true], ['I think the auth fix just needs, ', false], ['er, ', true], ['one more review.', false]],
    typed: 'I think the auth fix just needs one more review.',
  },
];

/** A press shorter than this is a tap: it toggles recording instead of push-to-talk. */
const TAP_MS = 350;
const TRANSCRIBE_MS = 500;
const MAX_SECONDS = 12;

type Phase = 'idle' | 'recording' | 'transcribing';

const PILL_IN = { duration: 0.15, ease: 'easeOut' } as const;
const PILL_OUT = { duration: 0.1, ease: 'easeIn' } as const;

/**
 * Interactive stage for the hero: hold the keycaps to talk (push-to-talk) or tap
 * to toggle, the pill appears bottom-center like the real overlay, and on stop
 * the clean transcript lands at the cursor. Plays one take on load.
 */
export function DictationDemo() {
  const reduceMotion = useReducedMotion() ?? false;
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [pressed, setPressed] = useState(false);
  const [lines, setLines] = useState<{ id: number; text: string }[]>(() => (reduceMotion ? [{ id: 0, text: PHRASES[0].typed }] : []));
  const [heard, setHeard] = useState<number | null>(() => (reduceMotion ? 0 : null));
  const [tapped, setTapped] = useState(false);

  const phaseRef = useRef<Phase>('idle');
  const pressStartRef = useRef(0);
  const nextPhraseRef = useRef(reduceMotion ? 1 : 0);
  const interactedRef = useRef(false);
  const timersRef = useRef<number[]>([]);

  const later = (fn: () => void, ms: number) => {
    timersRef.current.push(window.setTimeout(fn, ms));
  };

  const setPhaseBoth = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const start = () => {
    setPhaseBoth('recording');
    setSeconds(0);
    setHeard(null);
  };

  const stop = () => {
    if (phaseRef.current !== 'recording') return;
    setPhaseBoth('transcribing');
    setTapped(false);
    later(() => {
      const id = nextPhraseRef.current;
      const index = id % PHRASES.length;
      nextPhraseRef.current += 1;
      setLines((current) => [...current, { id, text: PHRASES[index].typed }].slice(-2));
      setHeard(index);
      setPhaseBoth('idle');
    }, TRANSCRIBE_MS);
  };

  const press = () => {
    interactedRef.current = true;
    setPressed(true);
    pressStartRef.current = performance.now();
    if (phaseRef.current === 'recording') {
      // Second tap of a toggle: stop on the press, like the real shortcut.
      pressStartRef.current = 0;
      stop();
    } else if (phaseRef.current === 'idle') {
      start();
    }
  };

  const release = () => {
    setPressed(false);
    if (!pressStartRef.current || phaseRef.current !== 'recording') return;
    const heldFor = performance.now() - pressStartRef.current;
    pressStartRef.current = 0;
    if (heldFor >= TAP_MS) stop();
    else setTapped(true);
  };

  // One take on load, unless the visitor gets there first.
  useEffect(() => {
    const timers = timersRef.current;
    if (!reduceMotion) {
      later(() => !interactedRef.current && start(), 900);
      later(() => !interactedRef.current && stop(), 3300);
    }
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Timer ticks at 1 Hz while recording; a forgotten toggle stops itself.
  useEffect(() => {
    if (phase !== 'recording') return undefined;
    const interval = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [phase]);

  useEffect(() => {
    if (seconds >= MAX_SECONDS) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds]);

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
      event.preventDefault();
      press();
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === ' ' || event.key === 'Enter') release();
  };

  const caption =
    phase === 'transcribing' ? <span className="text-muted-foreground">Transcribing…</span>
    : heard !== null ? (
      <span className="text-muted-foreground">
        <span className="mr-2 text-foreground/80">Heard</span>
        {PHRASES[heard].heard.map(([text, filler], i) =>
          filler ? <s key={i} className="text-muted-foreground/60 decoration-muted-foreground/60">{text}</s> : <span key={i}>{text}</span>,
        )}
      </span>
    ) : null;

  return (
    <div>
      <div id="dictation" className="relative scroll-mt-24 overflow-hidden rounded-[20px] border border-border bg-canvas">
        {/* The focused app: text lands at its cursor */}
        <div className="px-3 pt-8 pb-28 sm:px-10 sm:pt-12">
          <div className="mx-auto max-w-2xl overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_24px_60px_-24px_rgb(0_0_0/0.7)]">
            <div className="flex h-9 items-center justify-between border-b border-border/70 pl-4 text-xs text-muted-foreground select-none">
              <span>launch-notes.md · Notepad</span>
              <span className="flex h-full" aria-hidden="true">
                {['M3 6h6', 'M3.5 3.5h5v5h-5z', 'M3 3l6 6M9 3l-6 6'].map((d) => (
                  <svg key={d} viewBox="0 0 12 12" className="h-full w-11 px-4" fill="none" stroke="currentColor" strokeWidth="1">
                    <path d={d} />
                  </svg>
                ))}
              </span>
            </div>
            <div className="min-h-52 p-6 text-[15px] leading-7 sm:p-8">
              <p className="font-semibold">Launch notes</p>
              <p className="text-foreground/85">Tests are green on main. Signed build uploaded.</p>
              {lines.map((line, i) => (
                <motion.p
                  key={line.id}
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.15 }}
                  className="text-foreground/85"
                >
                  {line.text}
                  {i === lines.length - 1 && <Caret />}
                </motion.p>
              ))}
              {lines.length === 0 && <Caret />}
            </div>
          </div>
        </div>

        {/* Overlay slot: the pill while recording, then what was heard */}
        <div className="absolute inset-x-4 bottom-6 flex h-10 items-center justify-center" aria-live="polite">
          <AnimatePresence initial={false}>
            {phase === 'recording' ? (
              <motion.div
                key="pill"
                className="absolute"
                initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1, transition: PILL_IN }}
                exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.9, transition: PILL_OUT }}
              >
                <RecordingPill intent="dictation" seconds={seconds} />
              </motion.div>
            ) : caption ? (
              <motion.p
                key={phase === 'transcribing' ? 'transcribing' : `heard-${heard}`}
                className="absolute max-w-xl text-center text-[13px] leading-5 text-pretty"
                initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.25, 1, 0.5, 1] } }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}
              >
                {caption}
              </motion.p>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      {/* The shortcut itself is the control */}
      <div className="mt-6 flex flex-col items-center gap-3">
        <button
          type="button"
          data-pressed={pressed}
          className="cursor-pointer touch-none rounded-lg p-1 select-none"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            press();
          }}
          onPointerUp={release}
          onPointerCancel={release}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={() => pressed && release()}
        >
          <kbd className="keycap inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-raised px-4 font-sans text-[14px] font-medium text-foreground">
            <Mic className="size-4 text-voice" aria-hidden="true" />
            Hold to talk
          </kbd>
        </button>
        <p className="text-[13px] text-muted-foreground">
          {phase === 'recording' && tapped ? 'Recording. Tap again to stop.' : 'Hold to talk, or tap to start and tap again to stop. In the app, you pick the shortcut.'}
        </p>
      </div>
    </div>
  );
}

function Caret() {
  return <span aria-hidden="true" className="caret ml-0.5 inline-block h-[1.1em] w-px translate-y-[0.2em] bg-voice" />;
}
