import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { render, screen, cleanup, act } from '@testing-library/react';
import { RecordingPopup } from '../RecordingPopup';

type Listener = (...args: unknown[]) => void;

const listeners: Record<string, Listener[]> = {};
const spies: Array<{ mockRestore(): void }> = [];

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

function emit(channel: string, ...args: unknown[]) {
  (listeners[channel] ?? []).forEach((l) => l(...args));
}

/** Controls Date.now and collects interval ticks so the clock moves only when a test says so. */
function fakeClock(start: number) {
  const clock = { now: start, ticks: [] as Array<() => void> };
  spies.push(
    spyOn(Date, 'now').mockImplementation(() => clock.now),
    spyOn(window, 'setInterval').mockImplementation(((callback: () => void) => {
      clock.ticks.push(callback);
      return clock.ticks.length;
    }) as typeof setInterval),
    spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0),
  );
  return {
    advance(ms: number) {
      clock.now += ms;
      act(() => clock.ticks.forEach((tick) => tick()));
    },
  };
}

describe('RecordingPopup', () => {
  afterEach(() => {
    cleanup();
    spies.splice(0).forEach((spy) => spy.mockRestore());
  });

  it('shows an accessible restrained duration warning from provider orchestration', async () => {
    fakeClock(1_000_000);
    mockElectronAPI();
    render(<RecordingPopup intent="dictation" captureStartedAt={1_000_000} />);

    act(() => emit('recording:duration-warning', 10));

    expect(await screen.findByText('10s left')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', expect.stringContaining('Recording stops in 10 seconds'));
  });

  it('shows preparing without a running timer until capture starts', () => {
    const clock = fakeClock(1_000_000);
    mockElectronAPI();
    const { rerender } = render(<RecordingPopup intent="dictation" captureStartedAt={null} />);

    clock.advance(4000);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-label', 'Preparing microphone');
    expect(status).toHaveTextContent('Preparing mic…');
    expect(status).not.toHaveTextContent(/\d\d:\d\d/);

    // Audio-ready arrives 4s after the pill appeared; the clock starts there, not at show.
    rerender(<RecordingPopup intent="dictation" captureStartedAt={1_004_000} />);
    expect(status).toHaveAttribute('aria-label', 'Dictation recording in progress');
    expect(status).toHaveTextContent('00:00');

    clock.advance(2000);
    expect(status).toHaveTextContent('00:02');
  });
});
