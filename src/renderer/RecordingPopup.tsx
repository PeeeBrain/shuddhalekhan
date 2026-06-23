import { useEffect, useRef, useState } from 'react';
import { Mic, Bot } from 'lucide-react';
import type { RecordingIntent } from '../types/ipc';
import {
  BAR_COUNT,
  computeBarScale,
  PHASE_STEP,
  SMOOTHING_FACTOR,
} from './recording-popup-math';
import './RecordingPopup.css';

interface RecordingPopupProps {
  initialMode?: RecordingIntent;
}

export function RecordingPopup({ initialMode = 'dictation' }: RecordingPopupProps) {
  const [mode, setMode] = useState<RecordingIntent>(initialMode);
  const [level, setLevel] = useState(0);
  const [tick, setTick] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  const [pillState, setPillState] = useState<'hidden' | 'entering' | 'visible' | 'exiting'>(
    'hidden'
  );
  const targetLevelRef = useRef(0);
  const bars = Array.from({ length: BAR_COUNT });

  useEffect(() => {
    const removeMode = window.electronAPI?.on('recording:mode-changed', setMode);
    const removeLevel = window.electronAPI?.on('audio:level-changed', (l) => {
      targetLevelRef.current = l;
    });
    return () => {
      removeMode?.();
      removeLevel?.();
    };
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    const removeShow = window.electronAPI?.on('recording:pill-show', () => {
      setPillState(reducedMotion ? 'visible' : 'entering');
    });
    const removeHide = window.electronAPI?.on('recording:pill-hide', () => {
      setPillState(reducedMotion ? 'hidden' : 'exiting');
    });
    return () => {
      removeShow?.();
      removeHide?.();
    };
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
    if (reducedMotion) return;

    let raf = 0;
    const loop = () => {
      setLevel((current) => current + (targetLevelRef.current - current) * SMOOTHING_FACTOR);
      setTick((t) => (t + 1) % 1000000);
      raf = requestAnimationFrame(loop);
    };

    const handleVisibility = () => {
      if (document.hidden) {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      } else if (!raf) {
        raf = requestAnimationFrame(loop);
      }
    };

    raf = requestAnimationFrame(loop);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [reducedMotion]);

  useEffect(() => {
    const startTime = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const phase = tick * PHASE_STEP;

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const formatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden bg-transparent isolate">
      <div
        className={`pill-inner flex h-10 w-40 items-center justify-center gap-1 rounded-full border px-3 ${
          pillState === 'hidden' ? '' : pillState
        } ${
          mode === 'agent'
            ? 'border-[rgba(255,106,106,0.72)] shadow-[inset_0_0_14px_rgba(255,64,64,0.32),inset_0_0_28px_rgba(255,64,64,0.14)]'
            : 'border-[rgba(133,146,255,0.66)] shadow-[inset_0_0_14px_rgba(100,108,255,0.28),inset_0_0_28px_rgba(100,108,255,0.12)]'
        }`}
        style={{ background: 'rgba(20, 20, 23, 0.96)' }}
        role="status"
        aria-label={mode === 'agent' ? 'Agent mode recording in progress' : 'Dictation recording in progress'}
      >
        {mode === 'agent' ? (
          <Bot className="h-3.5 w-3.5 shrink-0 text-[#ff6a6a]" aria-hidden="true" />
        ) : (
          <Mic className="h-3.5 w-3.5 shrink-0 text-[#8592ff]" aria-hidden="true" />
        )}
        <div className="flex h-8 items-center gap-1">
          {bars.map((_, index) => {
            const scale = computeBarScale(level, phase, index);
            return (
              <span
                key={index}
                className={`bar ${mode}`}
                style={{ transform: `scaleY(${scale})` }}
              />
            );
          })}
        </div>
        <span className="text-[10px] font-mono tabular-nums text-white/70 select-none">
          {formatted}
        </span>
      </div>
    </div>
  );
}
