import { useEffect, useRef, useState } from 'react';
import type { RecordingIntent } from '../types/ipc';
import './RecordingPopup.css';

interface RecordingPopupProps {
  initialMode?: RecordingIntent;
}

export function RecordingPopup({ initialMode = 'dictation' }: RecordingPopupProps) {
  const [mode, setMode] = useState<RecordingIntent>(initialMode);
  const [level, setLevel] = useState(0);
  const [tick, setTick] = useState(0);
  const targetLevelRef = useRef(0);
  const bars = Array.from({ length: 10 });

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
      setLevel((current) => {
        const diff = targetLevelRef.current - current;
        return Math.abs(diff) < 0.001 ? targetLevelRef.current : current + diff * 0.22;
      });
      setTick((t) => (t + 1) % 1000000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const phase = tick * 0.09;

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
        <div className="flex h-5 items-center gap-1">
          {bars.map((_, index) => {
            const wave = Math.sin(phase + index * 0.75) * (0.15 + level * 0.25);
            const scale = Math.max(0.25, Math.min(1.4, 0.35 + level * 0.85 + wave));
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
