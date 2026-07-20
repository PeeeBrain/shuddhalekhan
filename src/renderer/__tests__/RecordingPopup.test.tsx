import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { RecordingPopup } from '../RecordingPopup';

type Listener = (...args: unknown[]) => void;

const listeners: Record<string, Listener[]> = {};
let dateSpy: ReturnType<typeof spyOn> | null = null;
let intervalSpy: ReturnType<typeof spyOn> | null = null;
let rafSpy: ReturnType<typeof spyOn> | null = null;

function mockElectronAPI() {
  for (const key of Object.keys(listeners)) delete listeners[key];

  (window as unknown as { electronAPI: unknown }).electronAPI = {
    on: (channel: string, callback: Listener) => {
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

describe('RecordingPopup timer reset', () => {
  afterEach(() => {
    cleanup();
    dateSpy?.mockRestore();
    dateSpy = null;
    intervalSpy?.mockRestore();
    intervalSpy = null;
    rafSpy?.mockRestore();
    rafSpy = null;
  });

  it('shows an accessible restrained duration warning from provider orchestration', async () => {
    rafSpy = spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0 as unknown as number);
    mockElectronAPI();
    render(<RecordingPopup initialMode="dictation" />);

    act(() => {
      emit('recording:pill-show');
      emit('recording:duration-warning', 10);
    });

    expect(await screen.findByText('10s left')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', expect.stringContaining('Recording stops in 10 seconds'));
  });

  it('resets the elapsed timer to 00:00 each time recording:pill-show fires', async () => {
    let currentTime = 1000000;
    const intervalCallbacks: Array<() => void> = [];

    dateSpy = spyOn(Date, 'now').mockImplementation(() => currentTime);
    intervalSpy = spyOn(window, 'setInterval').mockImplementation((callback: () => void) => {
      intervalCallbacks.push(callback);
      return 0 as unknown as number;
    });
    rafSpy = spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0 as unknown as number);

    mockElectronAPI();
    render(<RecordingPopup initialMode="dictation" />);

    act(() => {
      emit('recording:pill-show');
    });

    await waitFor(() => {
      expect(screen.getByText('00:00')).toBeInTheDocument();
    });

    currentTime += 3000;
    act(() => {
      intervalCallbacks.forEach((cb) => cb());
    });

    await waitFor(() => {
      expect(screen.getByText('00:03')).toBeInTheDocument();
    });

    act(() => {
      emit('recording:pill-show');
    });

    await waitFor(() => {
      expect(screen.getByText('00:00')).toBeInTheDocument();
    });
  });
});
