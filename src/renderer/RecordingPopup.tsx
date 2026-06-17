import { useEffect, useRef, useState } from 'react';
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
  }, []);

  const phase = tick * PHASE_STEP;

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden bg-transparent isolate">
      <div
        className={`flex h-10 w-24 items-center justify-center gap-1 rounded-full border px-3 transition-all duration-300 ease-out ${
          mode === 'agent'
            ? 'border-[rgba(255,106,106,0.72)] shadow-[inset_0_0_14px_rgba(255,64,64,0.32),inset_0_0_28px_rgba(255,64,64,0.14)]'
            : 'border-[rgba(133,146,255,0.66)] shadow-[inset_0_0_14px_rgba(100,108,255,0.28),inset_0_0_28px_rgba(100,108,255,0.12)]'
        }`}
        style={{ background: 'rgba(20, 20, 23, 0.96)' }}
        role="status"
        aria-label={mode === 'agent' ? 'Agent mode recording in progress' : 'Dictation recording in progress'}
      >
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
      </div>
    </div>
  );
}
