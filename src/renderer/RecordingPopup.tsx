import { useEffect, useState } from 'react';
import type { RecordingIntent } from '../types/ipc';
import './RecordingPopup.css';

interface RecordingPopupProps {
  initialMode?: RecordingIntent;
}

export function RecordingPopup({ initialMode = 'dictation' }: RecordingPopupProps) {
  const [mode, setMode] = useState<RecordingIntent>(initialMode);
  const bars = Array.from({ length: 12 });

  useEffect(() => {
    return window.electronAPI?.on('recording:mode-changed', setMode);
  }, []);

  return (
    <div className="recording-root">
      <div
        className={`recording-pill ${mode === 'agent' ? 'agent-mode' : 'dictation-mode'}`}
        role="status"
        aria-label={mode === 'agent' ? 'Agent mode recording in progress' : 'Dictation recording in progress'}
      >
        <div className="bars">
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
