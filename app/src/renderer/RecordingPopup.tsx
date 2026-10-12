import { useEffect, useRef, useState } from 'react';
import { Mic, Bot } from 'lucide-react';
import type { RecordingIntent } from '../types/ipc';
import {
  BAR_COUNT,
  computeBarScale,
  isWaveformSettled,
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
  // The waveform is painted straight to the DOM from refs: a level change must
  // not re-render React, and a silent mic must not repaint at all.
  const barRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const levelRef = useRef(0);
  const phaseRef = useRef(0);
  const wakeRef = useRef<(() => void) | null>(null);

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
    const frame = () => {
      raf = 0;
      const target = targetLevelRef.current;
      levelRef.current += (target - levelRef.current) * SMOOTHING_FACTOR;
      phaseRef.current += PHASE_STEP;
      barRefs.current.forEach((bar, index) => {
        if (bar) bar.style.transform = `scaleY(${computeBarScale(levelRef.current, phaseRef.current, index)})`;
      });
      // Park once silent; the next audible level wakes the loop again.
      if (!isWaveformSettled(target, levelRef.current) && !document.hidden) {
        raf = requestAnimationFrame(frame);
      }
    };
    const wake = () => {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    };

    wakeRef.current = wake;
    wake();
    document.addEventListener('visibilitychange', wake);
    return () => {
      wakeRef.current = null;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', wake);
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
        <div className={`h-8 flex-1 items-center justify-center gap-[3px] ${remainingSeconds === null ? 'flex' : 'hidden'}`} aria-hidden={remainingSeconds !== null}>
          {Array.from({ length: BAR_COUNT }, (_, index) => (
            <span
              key={index}
              ref={(bar) => { barRefs.current[index] = bar; }}
              className="bar"
              style={{ transform: `scaleY(${computeBarScale(0, 0, index)})` }}
            />
          ))}
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
