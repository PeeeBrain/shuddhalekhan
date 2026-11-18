import { BAND_COUNT, readBands, subscribeAudioLevel } from './audio-level';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Bot } from 'lucide-react';
import type { RecordingIntent } from '../types/ipc';
import {
  COMPUTE_COLUMNS,
  COMPUTE_STEP_MS,
  computeField,
  DOT_BASE_ALPHA,
  isWaveformSettled,
  layoutDots,
  MIN_FRAME_MS,
  SILENCE_LEVEL,
  smoothLevel,
  SWEEP_MS,
  sweepField,
  VOICE_COLUMNS,
  voiceField,
  WORK_COLUMNS,
} from './recording-popup-math';
import './RecordingPopup.css';

/**
 * Paints a dot field on whole device pixels. The canvas takes its tint from
 * CSS `color` and its dot shape from `--dot-shape`, so the intent styles it.
 */
function drawField(canvas: HTMLCanvasElement, intensities: number[], columns: number): void {
  const dpr = window.devicePixelRatio || 1;
  const { pitch, size, canvasWidth, canvasHeight } = layoutDots(columns, intensities.length / columns, dpr);
  const cssWidth = `${canvasWidth / dpr}px`;
  // A scale change can keep the rounded backing size but still change the CSS size.
  if (canvas.width !== canvasWidth || canvas.height !== canvasHeight || canvas.style.width !== cssWidth) {
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    canvas.style.width = cssWidth;
    canvas.style.height = `${canvasHeight / dpr}px`;
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  const style = getComputedStyle(canvas);
  // Below 3 device pixels a round dot only antialiases into a dimmer square.
  const radius = size >= 3 && style.getPropertyValue('--dot-shape').trim() !== 'square' ? size / 2 : 0;
  context.clearRect(0, 0, canvasWidth, canvasHeight);
  context.fillStyle = style.color;
  intensities.forEach((lit, index) => {
    context.globalAlpha = DOT_BASE_ALPHA + (1 - DOT_BASE_ALPHA) * lit;
    context.beginPath();
    context.roundRect((index % columns) * pitch, Math.floor(index / columns) * pitch, size, size, radius);
    context.fill();
  });
  context.globalAlpha = 1;
}

const drawVoice = (canvas: HTMLCanvasElement, bands: Float32Array, phase: number) =>
  drawField(canvas, voiceField(bands, phase), VOICE_COLUMNS);

function PillGlyph({ intent }: { intent: RecordingIntent }) {
  const Glyph = intent === 'agent' ? Bot : Mic;
  return (
    <span aria-hidden="true" className="recording-glyph flex size-7 shrink-0 items-center justify-center">
      <Glyph className="size-3.5" />
    </span>
  );
}

/** Follows the OS setting live, so turning it on mid-recording or mid-run stops motion at once. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);
  return reduced;
}

/** Calls `redraw` when the window moves to a display with another scale, so a parked or still field stays crisp. */
function useScaleChange(redraw: () => void): void {
  useEffect(() => {
    let query: MediaQueryList;
    const handleChange = () => {
      redraw();
      watch();
    };
    const watch = () => {
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      query.addEventListener('change', handleChange, { once: true });
    };
    watch();
    return () => query.removeEventListener('change', handleChange);
  }, [redraw]);
}

/**
 * A dot field that loops for as long as it is mounted, for work of unknown
 * length. `field` maps elapsed ms to intensities and must be stable. It draws
 * at most every `frameMs`, stops while the window is hidden, and under reduced
 * motion holds the frame at `stillMs`.
 */
function LoopingField({ columns, field, frameMs, stillMs }: {
  columns: number;
  field: (elapsedMs: number) => number[];
  frameMs: number;
  stillMs: number;
}) {
  const reducedMotion = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    if (canvas) drawField(canvas, field(0), columns);
  }, [columns, field]);
  // A running loop picks up the new scale on its next frame; only the reduced-motion still needs a redraw.
  useScaleChange(useCallback(() => {
    if (reducedMotion && canvasRef.current) drawField(canvasRef.current, field(stillMs), columns);
  }, [reducedMotion, field, stillMs, columns]));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (reducedMotion) {
      drawField(canvas, field(stillMs), columns);
      return;
    }
    let raf = 0;
    let last = 0;
    const start = performance.now();
    const frame = (now: number) => {
      raf = 0;
      if (document.hidden) return;
      raf = requestAnimationFrame(frame);
      if (now - last < frameMs) return;
      last = now;
      drawField(canvas, field(now - start), columns);
    };
    const wake = () => {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    };
    wake();
    document.addEventListener('visibilitychange', wake);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [columns, field, frameMs, stillMs, reducedMotion]);

  return <canvas ref={attachCanvas} />;
}

const sweepAt = (elapsedMs: number) => sweepField((elapsedMs % SWEEP_MS) / SWEEP_MS);

/**
 * The pill after recording stops: the same island and glyph, with a narrower
 * field and a beam crossing its resting line. Under reduced motion the beam
 * holds at the centre.
 */
export function ProcessingPill({ intent }: { intent: RecordingIntent }) {
  return (
    <div
      data-intent={intent}
      className="recording-island flex h-10 w-40 items-center gap-2 border pl-1.5 pr-3"
    >
      <PillGlyph intent={intent} />
      <div aria-hidden="true" className="flex h-8 items-center">
        <LoopingField columns={WORK_COLUMNS} field={sweepAt} frameMs={MIN_FRAME_MS} stillMs={SWEEP_MS / 2} />
      </div>
      <p className="m-0 whitespace-nowrap text-[11px] font-medium text-muted-foreground select-none">Transcribing…</p>
    </div>
  );
}

/**
 * Agent Mode's thinking state in the pill's dot language: bits flipping on a
 * small square-dot matrix, stepped like an LED panel at a low frame rate since
 * a model can think for many seconds. The word stays visible, so the state
 * never rests on motion alone.
 */
export function ThinkingField() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span aria-hidden="true" className="agent-dots inline-flex text-agent-accent">
        <LoopingField columns={COMPUTE_COLUMNS} field={computeField} frameMs={COMPUTE_STEP_MS - 1} stillMs={0} />
      </span>
      <span className="text-muted-foreground">Thinking…</span>
    </span>
  );
}

interface RecordingPopupProps {
  intent: RecordingIntent;
  /** Main's timestamp for the session's audio-ready; null while the mic is still opening. */
  captureStartedAt: number | null;
  remainingSeconds?: number | null;
}

/** Mounted once per recording session (keyed by the shell); all timing comes from the runtime snapshot. */
export function RecordingPopup({ intent: mode, captureStartedAt, remainingSeconds = null }: RecordingPopupProps) {
  const ready = captureStartedAt !== null;
  const [now, setNow] = useState(Date.now);
  const reducedMotion = useReducedMotion();
  const [pillState, setPillState] = useState<'hidden' | 'entering' | 'visible' | 'exiting'>('visible');
  const targetLevelRef = useRef(0);
  // The waveform is painted straight to a canvas from refs: a level change must
  // not re-render React, and a silent mic must not repaint at all.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Smoothed band levels, and the latest raw read they move toward each frame.
  const [bands] = useState(() => new Float32Array(BAND_COUNT));
  const [incoming] = useState(() => new Float32Array(BAND_COUNT));
  const loudestRef = useRef(0);
  const phaseRef = useRef(0);
  const wakeRef = useRef<(() => void) | null>(null);
  // Sizes and draws the canvas during commit, so its first paint is never the default 300×150.
  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    if (canvas) drawVoice(canvas, bands, phaseRef.current);
  }, [bands]);

  useEffect(() => {
    const unsubscribe = subscribeAudioLevel( (nextLevel) => {
      targetLevelRef.current = nextLevel;
      if (!isWaveformSettled(nextLevel, loudestRef.current)) wakeRef.current?.();
    });
    return unsubscribe;
  }, []);

  useScaleChange(useCallback(() => {
    if (canvasRef.current) drawVoice(canvasRef.current, bands, phaseRef.current);
  }, [bands]));

  // Optional so the dev pill preview also runs in a plain browser without the preload.
  useEffect(() => window.electronAPI?.subscribe('recording:pill-show', () => {
    setPillState(reducedMotion ? 'visible' : 'entering');
  }), [reducedMotion]);

  useEffect(() => window.electronAPI?.subscribe('recording:pill-hide', () => {
    setPillState(reducedMotion ? 'hidden' : 'exiting');
  }), [reducedMotion]);

  useEffect(() => {
    if (pillState === 'entering') {
      const timer = setTimeout(() => setPillState('visible'), 150);
      return () => clearTimeout(timer);
    }
    if (pillState === 'exiting') {
      const timer = setTimeout(() => setPillState('hidden'), 100);
      return () => clearTimeout(timer);
    }
  }, [pillState]);

  useEffect(() => {
    if (pillState === 'hidden') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Repaint for the new tint on mode change; under reduced motion this static shape is the whole waveform.
    drawVoice(canvas, bands, phaseRef.current);
    if (reducedMotion) return;

    let raf = 0;
    let last = 0;
    const frame = (now: number) => {
      raf = 0;
      if (document.hidden) return;
      // High-refresh displays draw at most 60 times a second.
      if (last && now - last < MIN_FRAME_MS) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const target = targetLevelRef.current;
      const elapsed = last ? now - last : 0;
      last = now;
      // Room noise below the silence gate never reaches the field, so a quiet mic rests on the line.
      // The bands give the voice's shape; its loudness scales them.
      const audible = target >= SILENCE_LEVEL && readBands(incoming);
      let loudest = 0;
      for (let band = 0; band < BAND_COUNT; band++) {
        bands[band] = smoothLevel(bands[band], audible ? incoming[band] * target : 0, elapsed);
        loudest = Math.max(loudest, bands[band]);
      }
      // The braid turns faster as the voice gets louder.
      phaseRef.current += ((2 + 6 * loudest) * elapsed) / 1000;
      // Park once silent, on the exact resting line; the next audible level wakes the loop again.
      const settled = isWaveformSettled(target, loudest);
      if (settled) bands.fill(0);
      loudestRef.current = settled ? 0 : loudest;
      drawVoice(canvas, bands, phaseRef.current);
      if (!settled) raf = requestAnimationFrame(frame);
    };
    const wake = () => {
      if (raf || document.hidden) return;
      last = 0; // a parked loop resumes without a time jump
      raf = requestAnimationFrame(frame);
    };

    wakeRef.current = wake;
    wake();
    document.addEventListener('visibilitychange', wake);
    return () => {
      wakeRef.current = null;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [reducedMotion, pillState, mode, ready, bands, incoming]);

  // No ticking while preparing: the clock starts at audio-ready, never at pill show.
  useEffect(() => {
    if (pillState === 'hidden' || !ready) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pillState, ready]);

  const elapsed = ready ? Math.max(0, Math.floor((now - captureStartedAt) / 1000)) : 0;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const formatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  const isAgent = mode === 'agent';

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden bg-transparent isolate">
      <div
        data-intent={mode}
        className={`pill-inner recording-island flex h-10 w-40 items-center gap-2.5 border pl-1.5 pr-3 ${
          pillState === 'hidden' ? '' : pillState
        }`}
        role="status"
        aria-label={ready
          ? `${isAgent ? 'Agent mode' : 'Dictation'} recording in progress${remainingSeconds === null ? '' : `. Recording stops in ${remainingSeconds} seconds`}`
          : 'Preparing microphone'}
      >
        <PillGlyph intent={mode} />
        {ready ? (
          <>
            <div className={`h-8 flex-1 items-center justify-center ${remainingSeconds === null ? 'flex' : 'hidden'}`} aria-hidden={remainingSeconds !== null}>
              <canvas ref={attachCanvas} />
            </div>
            {remainingSeconds !== null ? (
              <span className="flex-1 whitespace-nowrap text-[11px] font-medium tabular-nums text-warning">
                {remainingSeconds}s left
              </span>
            ) : null}
            <span className="text-[11px] tabular-nums text-muted-foreground select-none">
              {formatted}
            </span>
          </>
        ) : (
          <span className="flex-1 whitespace-nowrap text-[11px] font-medium text-muted-foreground select-none">
            Preparing mic…
          </span>
        )}
      </div>
    </div>
  );
}
