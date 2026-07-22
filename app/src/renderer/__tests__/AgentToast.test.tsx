import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AgentToast } from '../AgentToast';
import type { AgentToastState } from '../../types/ipc';

type Listener = (state: AgentToastState) => void;

const listeners = new Map<string, Listener>();
const send = mock();
const invoke = mock(() => Promise.resolve());

afterEach(() => {
  cleanup();
  listeners.clear();
  send.mockClear();
  invoke.mockClear();
});

describe('transcription failure toast', () => {
  it('offers Open Settings and Dismiss without exposing a blocking dialog', () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      on: (channel: string, listener: Listener) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
      send,
      invoke,
    };
    render(<AgentToast />);

    act(() => listeners.get('agent-toast:update')?.({
      kind: 'transcription-failed',
      message: 'The transcription endpoint was not found. Check provider settings.',
    }));

    expect(screen.getByRole('alert')).toHaveTextContent('Transcription failed');
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(invoke).toHaveBeenCalledWith('settings:open');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(send).toHaveBeenCalledWith('agent-toast:dismiss');
  });
});
