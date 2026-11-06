import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Bot } from 'lucide-react';
import type { RecordingIntent } from '../types/ipc';
import {
  BAR_COUNT,
  computeBarScale,
  isWaveformSettled,
  layoutBars,
  stepWaveform,
} from './recording-popup-math';
import './RecordingPopup.css';

const BAR_INDICES = Array.from({ length: BAR_COUNT }, (_, index) => index);

/** Paints the bars on whole device pixels; the canvas takes its tint from CSS `color`. */
function drawWaveform(canvas: HTMLCanvasElement, level: number, phase: number): void {
  const dpr = window.devicePixelRatio || 1;
  const { canvasWidth, canvasHeight, bars } = layoutBars(
    BAR_INDICES.map((index) => computeBarScale(level, phase, index)),
    dpr,
  );
  if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    canvas.style.width = `${canvasWidth / dpr}px`;
    canvas.style.height = `${canvasHeight / dpr}px`;
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvasWidth, canvasHeight);
  context.fillStyle = getComputedStyle(canvas).color;
  context.beginPath();
  for (const bar of bars) context.roundRect(bar.x, bar.y, bar.width, bar.height, bar.width / 2);
  context.fill();
}

interface RecordingPopupProps {
  initialMode?: RecordingIntent;
  recordingSessionId?: string;
}

export function RecordingPopup({
  initialMode = 'dictation',
  recordingSessionId,
}: RecordingPopupProps) {
  const [mode, setMode] = useState<RecordingIntent>(initialMode);
  const [elapsed, setElapsed] = useState(0);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const recordingStartRef = useRef<number | null>(null);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  const [pillState, setPillState] = useState<'hidden' | 'entering' | 'visible' | 'exiting'>(
    recordingSessionId ? 'visible' : 'hidden'
  );
  const targetLevelRef = useRef(0);
  // The waveform is painted straight to a canvas from refs: a level change must
  // not re-render React, and a silent mic must not repaint at all.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelRef = useRef(0);
  const phaseRef = useRef(0);
  const wakeRef = useRef<(() => void) | null>(null);
  // Sizes and draws the canvas during commit, so its first paint is never the default 300×150.
  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    if (canvas) drawWaveform(canvas, levelRef.current, phaseRef.current);
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI.subscribe('recording:mode-changed', setMode);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI.subscribe('audio:level-changed', (nextLevel) => {
      targetLevelRef.current = nextLevel;
      if (!isWaveformSettled(nextLevel, levelRef.current)) wakeRef.current?.();
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI.subscribe('recording:duration-warning', setRemainingSeconds);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI.subscribe('recording:pill-show', () => {
      recordingStartRef.current = Date.now();
      setElapsed(0);
      setRemainingSeconds(null);
      setPillState(reducedMotion ? 'visible' : 'entering');
    });
    return unsubscribe;
  }, [reducedMotion]);

  useEffect(() => {
    if (!recordingSessionId) return;
    recordingStartRef.current = Date.now();
  }, [recordingSessionId]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.subscribe('recording:pill-hide', () => {
      recordingStartRef.current = null;
      setPillState(reducedMotion ? 'hidden' : 'exiting');
    });
    return unsubscribe;
  }, [reducedMotion]);

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
    drawWaveform(canvas, levelRef.current, phaseRef.current);
    if (reducedMotion) return;

    let raf = 0;
    let last = 0;
    const frame = (now: number) => {
      raf = 0;
      const target = targetLevelRef.current;
      const next = stepWaveform(levelRef.current, phaseRef.current, target, last ? now - last : 0);
      last = now;
      levelRef.current = next.level;
      phaseRef.current = next.phase;
      drawWaveform(canvas, next.level, next.phase);
      // Park once silent; the next audible level wakes the loop again.
      if (!isWaveformSettled(target, levelRef.current) && !document.hidden) {
        raf = requestAnimationFrame(frame);
      }
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
  }, [reducedMotion, pillState, mode]);

  useEffect(() => {
    if (pillState === 'hidden') return;
    const id = setInterval(() => {
      if (recordingStartRef.current !== null) {
        setElapsed(Math.floor((Date.now() - recordingStartRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [pillState]);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const formatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  const isAgent = mode === 'agent';
  const Glyph = isAgent ? Bot : Mic;

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden bg-transparent isolate">
      <div
        data-intent={mode}
        className={`pill-inner recording-island flex h-10 w-40 items-center gap-2.5 border pl-1.5 pr-3 ${
          pillState === 'hidden' ? '' : pillState
        }`}
        role="status"
        aria-label={`${isAgent ? 'Agent mode' : 'Dictation'} recording in progress${remainingSeconds === null ? '' : `. Recording stops in ${remainingSeconds} seconds`}`}
      >
        <span aria-hidden="true" className="recording-glyph flex size-7 shrink-0 items-center justify-center">
          <Glyph className="size-3.5" />
        </span>
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
      </div>
    </div>
  );
}
