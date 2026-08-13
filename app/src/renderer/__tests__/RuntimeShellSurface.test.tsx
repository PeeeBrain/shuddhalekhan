import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import { RuntimeShellSurface } from '../RuntimeShellSurface';

let listener: ((snapshot: any) => void) | null = null;
const send = mock(() => undefined);

afterEach(() => {
  cleanup();
  listener = null;
  send.mockClear();
});

describe('runtime shell presentation', () => {
  it('shows only declared recovery actions and ignores stale revisions', () => {
    (window as any).electronAPI = {
      subscribe: (_channel: string, callback: (snapshot: any) => void) => {
        listener = callback;
        return () => { listener = null; };
      },
      send,
    };
    render(<RuntimeShellSurface />);

    act(() => listener?.({
      kind: 'failure', generation: 2, revision: 4, recordingSessionId: 'session-1',
      message: 'Automatic paste failed.',
      recoveryActions: ['retry-paste', 'copy-full-transcript'],
    }));

    expect(screen.getByRole('alert')).toHaveTextContent('Automatic paste failed.');
    expect(screen.getByRole('button', { name: 'Retry Paste' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Full Transcript' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /partial/i })).not.toBeInTheDocument();

    act(() => listener?.({ kind: 'idle', generation: 2, revision: 3 }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    screen.getByRole('button', { name: 'Copy Full Transcript' }).click();
    expect(send).toHaveBeenCalledWith('runtime:recovery-action', 'copy-full-transcript');
  });
});
