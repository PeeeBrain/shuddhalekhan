import { afterEach, describe, expect, it, mock } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { RecordingPopup } from '../RecordingPopup';

type Listener = (...args: unknown[]) => void;

const listeners: Record<string, Listener[]> = {};

function mockElectronAPI() {
  for (const key of Object.keys(listeners)) delete listeners[key];

  (window as unknown as { electronAPI: unknown }).electronAPI = {
    subscribe: (channel: string, callback: Listener) => {
      if (!listeners[channel]) listeners[channel] = [];
      listeners[channel].push(callback);
      return () => {
        listeners[channel] = (listeners[channel] ?? []).filter((l) => l !== callback);
      };
    },
    send: mock(() => {}),
    invoke: mock(() => Promise.resolve()),
  };
}

describe('RecordingPopup', () => {
  afterEach(cleanup);

  it('shows an accessible duration warning from provider orchestration', () => {
    mockElectronAPI();
    render(<RecordingPopup intent="dictation" captureStartedAt={Date.now()} remainingSeconds={10} />);

    expect(screen.getByText('10s left')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', expect.stringContaining('Recording stops in 10 seconds'));
  });
});
