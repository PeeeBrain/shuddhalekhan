import { useEffect, useState } from 'react';
import type { RecordingIntent } from '../types/ipc';
import './RecordingPopup.css';

interface RecordingPopupProps {
  initialMode?: RecordingIntent;
}

export function RecordingPopup({ initialMode = 'dictation' }: RecordingPopupProps) {
  const [mode, setMode] = useState<RecordingIntent>(initialMode);
  const bars = Array.from({ length: 10 });

  useEffect(() => {
    return window.electronAPI?.on('recording:mode-changed', setMode);
  }, []);

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden bg-transparent isolate">
      <div
        className={`flex h-9 w-[90px] items-center justify-center gap-2.5 rounded-full border px-3 transition-all duration-300 ease-out ${
          mode === 'agent'
            ? 'border-[rgba(255,106,106,0.72)] shadow-[inset_0_0_14px_rgba(255,64,64,0.32),inset_0_0_28px_rgba(255,64,64,0.14)]'
            : 'border-[rgba(133,146,255,0.66)] shadow-[inset_0_0_14px_rgba(100,108,255,0.28),inset_0_0_28px_rgba(100,108,255,0.12)]'
        }`}
        style={{ background: 'rgba(20, 20, 23, 0.96)' }}
        role="status"
        aria-label={mode === 'agent' ? 'Agent mode recording in progress' : 'Dictation recording in progress'}
      >
        <div className="flex h-4 items-center gap-0.5">
          {bars.map((_, index) => (
            <span
              key={index}
              className="bar"
              style={{ animationDelay: `${index * 0.06}s` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
