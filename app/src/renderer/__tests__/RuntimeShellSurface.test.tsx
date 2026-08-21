import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import { RuntimeShellSurface } from '../RuntimeShellSurface';

const listeners = new Map<string, Array<(...args: any[]) => void>>();
const send = mock(() => undefined);

function emit(channel: string, ...args: any[]) {
  (listeners.get(channel) ?? []).forEach((cb) => cb(...args));
}

afterEach(() => {
  cleanup();
  listeners.clear();
  send.mockClear();
});

describe('runtime shell presentation', () => {
  it('shows only declared recovery actions and ignores stale revisions', () => {
    (window as any).electronAPI = {
      subscribe: (channel: string, callback: (...args: any[]) => void) => {
        const list = listeners.get(channel) ?? [];
        list.push(callback);
        listeners.set(channel, list);
        return () => {
          listeners.set(channel, (listeners.get(channel) ?? []).filter((cb) => cb !== callback));
        };
      },
      send,
    };
    render(<RuntimeShellSurface />);

    act(() => emit('runtime:snapshot', {
      kind: 'failure', generation: 2, revision: 4, recordingSessionId: 'session-1',
      message: 'Automatic paste failed.',
      recoveryActions: ['retry-paste', 'copy-full-transcript'],
    }));

    expect(screen.getByRole('alert')).toHaveTextContent('Automatic paste failed.');
    expect(screen.getByRole('button', { name: 'Retry Paste' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Full Transcript' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /partial/i })).not.toBeInTheDocument();

    act(() => emit('runtime:snapshot', { kind: 'idle', generation: 2, revision: 3 }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    screen.getByRole('button', { name: 'Copy Full Transcript' }).click();
    expect(send).toHaveBeenCalledWith('runtime:recovery-action', 'copy-full-transcript');
  });

  it('acknowledges Retry Paste and blocks duplicate recovery actions', () => {
    (window as any).electronAPI = {
      subscribe: (channel: string, callback: (...args: any[]) => void) => {
        const list = listeners.get(channel) ?? [];
        list.push(callback);
        listeners.set(channel, list);
        return () => listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((cb) => cb !== callback),
        );
      },
      send,
    };
    render(<RuntimeShellSurface />);

    act(() => emit('runtime:snapshot', {
      kind: 'failure', generation: 1, revision: 1, recordingSessionId: 'session-1',
      message: 'Automatic paste failed.',
      recoveryActions: ['retry-paste', 'copy-full-transcript'],
    }));

    act(() => screen.getByRole('button', { name: 'Retry Paste' }).click());

    expect(send).toHaveBeenCalledWith('runtime:recovery-action', 'retry-paste');
    expect(screen.getByRole('button', { name: 'Retrying...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy Full Transcript' })).toBeEnabled();

    act(() => emit('runtime:snapshot', {
      kind: 'failure', generation: 1, revision: 2, recordingSessionId: null,
      message: 'Focus is still elsewhere.',
      recoveryActions: ['retry-paste', 'copy-full-transcript'],
    }));

    expect(screen.getByRole('button', { name: 'Retry Paste' })).toBeEnabled();
    expect(screen.getByText('Focus is still elsewhere.')).toBeInTheDocument();
  });

  it('shows committed and tentative streaming text without announcing every tentative revision', () => {
    (window as any).electronAPI = {
      subscribe: (channel: string, callback: (...args: any[]) => void) => {
        const list = listeners.get(channel) ?? [];
        list.push(callback);
        listeners.set(channel, list);
        return () => listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((cb) => cb !== callback),
        );
      },
      send,
    };
    render(<RuntimeShellSurface />);

    act(() => emit('runtime:snapshot', {
      kind: 'recording',
      generation: 1,
      revision: 2,
      recordingSessionId: 'live-session',
      intent: 'dictation',
      capabilities: { batch: true, streaming: true },
      durationWarningSeconds: null,
      committed: 'Hello ',
      tentative: 'Hello world',
    }));

    expect(screen.getByTestId('streaming-committed')).toHaveTextContent('Hello');
    expect(screen.getByTestId('streaming-tentative')).toHaveTextContent('world');
    expect(screen.getByTestId('streaming-preview')).toHaveAttribute('aria-live', 'off');
  });

  it('shows a passive amber insertion-halted banner while recording continues', () => {
    (window as any).electronAPI = {
      subscribe: (channel: string, callback: (...args: any[]) => void) => {
        const list = listeners.get(channel) ?? [];
        list.push(callback);
        listeners.set(channel, list);
        return () => listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((cb) => cb !== callback),
        );
      },
      send: () => undefined,
    };
    render(<RuntimeShellSurface />);

    act(() => emit('runtime:snapshot', {
      kind: 'recording',
      generation: 1,
      revision: 3,
      recordingSessionId: 'live-session',
      intent: 'dictation',
      capabilities: { batch: true, streaming: true },
      durationWarningSeconds: null,
      committed: 'Hello',
      tentative: 'Hello world',
      insertionHalted: true,
    }));

    expect(screen.getByTestId('insertion-halted')).toHaveTextContent('Insertion stopped — recording continues');
  });

  it('renders exactly one visual presentation state and replaces recording with processing', () => {
    (window as any).electronAPI = {
      subscribe: (channel: string, callback: (...args: any[]) => void) => {
        const list = listeners.get(channel) ?? [];
        list.push(callback);
        listeners.set(channel, list);
        return () => {
          listeners.set(channel, (listeners.get(channel) ?? []).filter((cb) => cb !== callback));
        };
      },
      send,
    };
    const { container } = render(<RuntimeShellSurface />);

    // Initially idle / null
    expect(container.firstChild).toBeNull();

    // Transition to recording
    act(() => {
      emit('runtime:snapshot', {
        kind: 'recording',
        generation: 1,
        revision: 1,
        recordingSessionId: 'session-1',
        intent: 'dictation',
        capabilities: { batch: true, streaming: false },
        durationWarningSeconds: null,
      });
      emit('recording:pill-show', 'session-1');
    });

    expect(screen.getByRole('status')).toHaveClass('visible');
    expect(screen.queryByText('Processing…')).not.toBeInTheDocument();

    // Transition to processing: recording indicator must be replaced by processing
    act(() => emit('runtime:snapshot', {
      kind: 'processing',
      generation: 1,
      revision: 2,
      recordingSessionId: 'session-1',
    }));

    const processingSurface = screen.getByRole('status', { name: 'Processing transcription' });
    expect(processingSurface).toHaveClass('bg-transparent');
    expect(screen.getByText('Processing…').parentElement).toHaveClass('h-10', 'w-40', 'rounded-full');
    expect(screen.queryByRole('status', { name: /recording in progress/i })).not.toBeInTheDocument();

    // Transition to idle
    act(() => emit('runtime:snapshot', {
      kind: 'idle',
      generation: 1,
      revision: 3,
    }));

    expect(container.firstChild).toBeNull();
  });
});
