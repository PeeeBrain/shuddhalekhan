import { useEffect, useRef, useState } from 'react';
import type { DictationRecoveryAction, RuntimePresentationSnapshot } from '../types/ipc';
import { Button } from './components/ui/button';
import { RecordingPopup } from './RecordingPopup';

const ACTION_LABELS: Record<DictationRecoveryAction, string> = {
  'retry-paste': 'Retry Paste',
  'copy-full-transcript': 'Copy Full Transcript',
  'copy-partial-transcript': 'Copy Partial Transcript',
};

export function RuntimeShellSurface() {
  const [snapshot, setSnapshot] = useState<RuntimePresentationSnapshot | null>(null);
  const latest = useRef({ generation: 0, revision: 0 });

  useEffect(() => window.electronAPI.subscribe('runtime:snapshot', (next) => {
    const current = latest.current;
    if (
      next.generation < current.generation
      || (next.generation === current.generation && next.revision <= current.revision)
    ) return;
    latest.current = { generation: next.generation, revision: next.revision };
    setSnapshot(next);
  }), []);

  if (!snapshot || snapshot.kind === 'idle') return null;

  if (snapshot.kind === 'recording') {
    return (
      <RecordingPopup
        key={snapshot.recordingSessionId}
        initialMode={snapshot.intent}
        recordingSessionId={snapshot.recordingSessionId}
      />
    );
  }

  if (snapshot.kind === 'processing') {
    return (
      <main
        role="status"
        aria-label="Processing transcription"
        aria-live="polite"
        className="flex h-screen w-screen items-center justify-center bg-transparent"
      >
        <div
          className="flex h-10 w-40 items-center justify-center gap-2 rounded-full border border-[rgba(133,146,255,0.42)] text-[11px] font-medium text-white/70 shadow-[inset_0_0_14px_rgba(100,108,255,0.16),inset_0_0_28px_rgba(100,108,255,0.06)]"
          style={{ background: 'rgba(20, 20, 23, 0.96)' }}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-[#8592ff] shadow-[0_0_6px_rgba(133,146,255,0.65)]"
          />
          <span>Processing…</span>
        </div>
      </main>
    );
  }

  return (
    <main role="alert" className="flex h-screen w-screen flex-col rounded-lg border border-border border-l-4 border-l-destructive bg-card p-4 text-card-foreground shadow-xl">
      <h1 className="text-sm font-semibold">Dictation needs attention</h1>
      <p className="mt-2 flex-1 overflow-auto text-sm text-muted-foreground">{snapshot.message}</p>
      {snapshot.recoveryActions.length ? (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {snapshot.recoveryActions.map((action) => (
            <Button
              key={action}
              type="button"
              variant={action === 'retry-paste' ? 'default' : 'outline'}
              size="sm"
              onClick={() => window.electronAPI?.send('runtime:recovery-action', action)}
            >
              {ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      ) : null}
    </main>
  );
}
