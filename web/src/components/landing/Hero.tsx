import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import type { MotionProps } from 'motion/react';
import { ArrowRight, Check, Mic } from 'lucide-react';
import { LatestWindowsDownloadLink } from '@/components/LatestWindowsDownloadLink';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

const TRANSCRIPT_PHRASE = 'Hey Sarah, just pushed the auth fix to staging. Can you take a look?';

/* Staggered mount choreography for everything above the fold. */
const STATIC_ENTER = { initial: false } satisfies MotionProps;

const ENTER = (delay: number, reduceMotion: boolean) => reduceMotion
  ? STATIC_ENTER
  : {
      initial: { opacity: 0, y: 32 },
      animate: { opacity: 1, y: 0 },
      transition: { duration: 0.9, delay, ease: EASE_OUT_EXPO },
    } satisfies MotionProps;

const HERO_CHECKS = ['No subscription', 'Works offline', 'Bring your own keys'];

function useTypewriter(reduceMotion: boolean) {
  const [charIdx, setCharIdx] = useState(0);

  useEffect(() => {
    if (reduceMotion || charIdx >= TRANSCRIPT_PHRASE.length) return undefined;
    const timeout = setTimeout(() => setCharIdx((current) => current + 1), 34);
    return () => clearTimeout(timeout);
  }, [charIdx, reduceMotion]);

  return reduceMotion ? TRANSCRIPT_PHRASE : TRANSCRIPT_PHRASE.slice(0, charIdx);
}

/** Faithful miniature of the desktop recording pill (periwinkle dictation mode). */
function RecordingPill({ reduceMotion }: { reduceMotion: boolean }) {
  const [seconds, setSeconds] = useState(2);

  useEffect(() => {
    if (reduceMotion || seconds >= 8) return undefined;
    const timer = setTimeout(() => setSeconds((current) => current + 1), 1000);
    return () => clearTimeout(timer);
  }, [reduceMotion, seconds]);

  const displayedSeconds = reduceMotion ? 8 : seconds;
  const label = `0:${String(displayedSeconds).padStart(2, '0')}`;

  return (
    <div className="pointer-events-none flex h-11 w-44 items-center justify-center gap-2.5 rounded-full border border-[rgba(133,146,255,0.66)] bg-[#101120]/95 px-4 shadow-[inset_0_0_14px_rgba(100,108,255,0.28),inset_0_0_28px_rgba(100,108,255,0.12),0_16px_40px_rgba(0,0,0,0.55)]">
      <Mic className="size-3.5 shrink-0 text-voice" aria-hidden="true" />
      <div className="flex h-4 items-center gap-[3px]" aria-hidden="true">
        {[0.9, 1.15, 0.75, 1.3, 1].map((duration, i) => (
          <span
            key={i}
            className="eq-bar block h-full w-[3px] rounded-full bg-voice/90"
            style={{ animationDuration: `${duration}s`, animationDelay: `${i * -0.22}s` }}
          />
        ))}
      </div>
      <span className="font-mono text-[11px] font-semibold tracking-widest text-white/90">{label}</span>
    </div>
  );
}

export function Hero() {
  const reduceMotion = useReducedMotion() ?? false;
  const transcript = useTypewriter(reduceMotion);

  // Device rises and settles into place as it scrolls into view.
  const deviceRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: deviceRef, offset: ['start end', 'start center'] });
  const scale = useTransform(scrollYProgress, [0, 1], [0.94, 1]);
  const deviceY = useTransform(scrollYProgress, [0, 1], [56, 0]);
  const opacity = useTransform(scrollYProgress, [0, 0.55], [0.35, 1]);

  const deviceStyle = reduceMotion ? undefined : { scale, y: deviceY, opacity };

  return (
    <section className="relative overflow-hidden pt-36 pb-20 md:pt-44">
      {/* Ambient signal glow behind the headline */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-[-320px] left-1/2 h-[640px] w-[1100px] -translate-x-1/2 bg-[radial-gradient(closest-side,rgba(133,146,255,0.14),transparent)]"
      />

      <div className="relative mx-auto max-w-6xl px-6 text-center">
        <motion.div {...ENTER(0, reduceMotion)}>
          <Badge
            variant="outline"
            className="h-7 gap-2 rounded-full border-white/12 bg-white/[0.04] px-3.5 text-xs font-medium text-muted-foreground"
          >
            <span className="animate-live-dot size-1.5 rounded-full bg-voice" aria-hidden="true" />
            Free &amp; open source · Built for Windows
          </Badge>
        </motion.div>

        <motion.h1
          {...ENTER(0.08, reduceMotion)}
          className="mx-auto mt-7 max-w-3xl text-balance text-5xl leading-[1.05] font-semibold tracking-[-0.03em] sm:text-6xl md:text-7xl"
        >
          Say it once.
          <span className="block text-muted-foreground">Typed everywhere.</span>
        </motion.h1>

        <motion.p {...ENTER(0.16, reduceMotion)} className="mx-auto mt-6 max-w-xl text-balance text-base leading-relaxed text-muted-foreground sm:text-lg">
          Shuddhalekhan transcribes your voice with Whisper, cleans it up, and types it into the app you’re
          already using. Free and open source, no subscription.
        </motion.p>

        <motion.div {...ENTER(0.24, reduceMotion)} className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button
            asChild
            className="h-12 rounded-full bg-foreground px-7 text-sm font-semibold text-primary-foreground shadow-[0_8px_30px_rgba(0,0,0,0.45)] transition-[background-color,transform] duration-300 hover:bg-white active:scale-[0.98]"
          >
            <LatestWindowsDownloadLink>
              <svg className="fill-current" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M0 0h7.5v7.5H0V0zm8.5 0H16v7.5H8.5V0zM0 8.5h7.5V16H0V8.5zm8.5 0H16V16H8.5V8.5z" />
              </svg>
              Download for Windows
            </LatestWindowsDownloadLink>
          </Button>
          <Button
            asChild
            variant="outline"
            className="h-12 rounded-full border-white/15 px-6 text-sm font-semibold text-zinc-200 transition-colors duration-300 hover:border-white/30 hover:bg-white/[0.04] hover:text-white"
          >
            <a href="#how-it-works">
              See it in action
              <ArrowRight />
            </a>
          </Button>
        </motion.div>

        <motion.div {...ENTER(0.32, reduceMotion)} className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
          {HERO_CHECKS.map((item) => (
            <span key={item} className="flex items-center gap-1.5">
              <Check className="size-3.5 text-voice" aria-hidden="true" />
              {item}
            </span>
          ))}
        </motion.div>

        {/* Device mock */}
        <div ref={deviceRef} className="relative mx-auto mt-16 max-w-3xl scroll-mt-28 md:mt-20">
          <div
            aria-hidden="true"
            className="absolute -inset-8 bg-[radial-gradient(closest-side,rgba(133,146,255,0.09),transparent)]"
          />
          <motion.div
            id="demo"
            style={deviceStyle}
            className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0b0c13] shadow-[0_40px_120px_rgba(0,0,0,0.6)]"
          >
            {/* Title bar */}
            <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-4 py-2.5 select-none">
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span>notes.md</span>
              </div>
              <div className="flex items-center gap-3.5 text-zinc-500">
                <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-emerald-400/90 uppercase">
                  <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                  dictating
                </span>
                <svg className="size-2.5 fill-current" viewBox="0 0 12 12" aria-hidden="true"><rect y="5" width="12" height="1.5" /></svg>
                <svg className="size-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" /></svg>
                <svg className="size-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M1.5 1.5l9 9M10.5 1.5l-9 9" /></svg>
              </div>
            </div>

            {/* Live transcript */}
            <div className="flex min-h-[240px] flex-col justify-center p-8 text-left sm:p-12">
              <p className="min-h-20 text-lg leading-relaxed font-medium text-zinc-100 sm:text-xl">
                {transcript}
                <span className="animate-caret ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[0.2em] bg-voice align-baseline" aria-hidden="true" />
              </p>
              <p className="mt-6 border-l-2 border-voice/50 pl-3 text-xs leading-relaxed text-zinc-500">
                Shuddhalekhan strips the ums before this text reaches your app.
              </p>
            </div>
          </motion.div>

          {/* Recording pill straddling the window edge, like the real overlay.
              Outer div owns centering so Motion can own transform during the entrance. */}
          <div className="absolute -bottom-6 left-1/2 -translate-x-1/2">
            <motion.div {...ENTER(0.5, reduceMotion)}>
              <RecordingPill reduceMotion={reduceMotion} />
            </motion.div>
          </div>
        </div>

        <motion.p {...ENTER(0.62, reduceMotion)} className="mx-auto mt-16 max-w-md text-sm text-muted-foreground">
          Hold the global shortcut, say what you need, and clean text shows up at your cursor.
        </motion.p>
      </div>
    </section>
  );
}
