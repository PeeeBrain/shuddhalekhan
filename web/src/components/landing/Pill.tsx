import { Bot, Mic } from 'lucide-react';
import type { CSSProperties } from 'react';

/* Fixed per-bar peaks and phases so the level reads like speech, not a metronome. */
const BARS = [0.45, 0.8, 0.6, 1, 0.7, 0.9, 0.5, 0.85, 0.55, 0.4];

/** Miniature of the desktop recording pill (160 × 40), same shapes as the app. */
export function RecordingPill({ intent, seconds }: { intent: 'dictation' | 'agent'; seconds: number }) {
  const Glyph = intent === 'agent' ? Bot : Mic;

  return (
    <div data-intent={intent} className="pill flex h-10 w-40 items-center gap-2.5 pr-3 pl-1.5">
      <span aria-hidden="true" className="pill-glyph flex size-7 shrink-0 items-center justify-center">
        <Glyph className="size-3.5" />
      </span>
      <span aria-hidden="true" className="flex h-8 flex-1 items-center justify-center gap-[3px]">
        {BARS.map((peak, i) => (
          <span
            key={i}
            className="pill-bar"
            style={{ '--peak': peak, animationDuration: `${0.5 + peak * 0.5}s`, animationDelay: `${i * -0.13}s` } as CSSProperties}
          />
        ))}
      </span>
      <span className="text-[11px] text-muted-foreground tabular-nums select-none">
        {`00:${String(seconds).padStart(2, '0')}`}
      </span>
    </div>
  );
}

