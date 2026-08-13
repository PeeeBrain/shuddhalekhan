import { useEffect, useRef, useState } from 'react';
import type { DictationRecoveryAction, RuntimePresentationSnapshot } from '../types/ipc';
import { Button } from './components/ui/button';

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

  if (!snapshot || snapshot.kind === 'idle' || snapshot.kind === 'recording') return null;

  if (snapshot.kind === 'processing') {
    return (
      <main aria-live="polite" className="flex h-screen w-screen items-center justify-center rounded-full border border-border bg-card text-sm text-muted-foreground shadow-lg">
        Processing…
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
