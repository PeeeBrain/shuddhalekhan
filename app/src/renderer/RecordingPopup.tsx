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
  recordingSessionId?: string;
}

export function RecordingPopup({
  initialMode = 'dictation',
  recordingSessionId,
}: RecordingPopupProps) {
  const [mode, setMode] = useState<RecordingIntent>(initialMode);
  const [level, setLevel] = useState(0);
  const [tick, setTick] = useState(0);
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
  const bars = Array.from({ length: BAR_COUNT });

  useEffect(() => {
    const unsubscribe = window.electronAPI.subscribe('recording:mode-changed', setMode);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI.subscribe('audio:level-changed', (nextLevel) => {
      targetLevelRef.current = nextLevel;
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
    const unsubscribe = window.electronAPI.subscribe('recording:pill-show', (recordingSessionId) => {
      recordingStartRef.current = Date.now();
      setElapsed(0);
      setRemainingSeconds(null);
      setPillState(reducedMotion ? 'visible' : 'entering');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.electronAPI?.send('surface-paint-proxy', 'recording', recordingSessionId);
        });
      });
    });
    return unsubscribe;
  }, [reducedMotion]);

  useEffect(() => {
    if (!recordingSessionId) return;
    recordingStartRef.current = Date.now();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.electronAPI?.send('surface-paint-proxy', 'recording', recordingSessionId);
      });
    });
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
    if (reducedMotion || pillState === 'hidden') return;

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
  }, [reducedMotion, pillState]);

  useEffect(() => {
    if (pillState === 'hidden') return;
    const id = setInterval(() => {
      if (recordingStartRef.current !== null) {
        setElapsed(Math.floor((Date.now() - recordingStartRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [pillState]);

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
        aria-label={`${mode === 'agent' ? 'Agent mode' : 'Dictation'} recording in progress${remainingSeconds === null ? '' : `. Recording stops in ${remainingSeconds} seconds`}`}
      >
        {mode === 'agent' ? (
          <Bot className="h-3.5 w-3.5 shrink-0 text-[#ff6a6a]" aria-hidden="true" />
        ) : (
          <Mic className="h-3.5 w-3.5 shrink-0 text-[#8592ff]" aria-hidden="true" />
        )}
        <div className={`h-8 items-center gap-1 ${remainingSeconds === null ? 'flex' : 'hidden'}`} aria-hidden={remainingSeconds !== null}>
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
        {remainingSeconds !== null ? (
          <span className="ml-1 whitespace-nowrap text-[10px] font-medium tabular-nums text-amber-300">
            {remainingSeconds}s left
          </span>
        ) : null}
      </div>
    </div>
  );
}
