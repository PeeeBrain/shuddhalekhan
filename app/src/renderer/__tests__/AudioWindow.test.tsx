import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, render } from '@testing-library/react';
import type { CaptureBoundary, RecordingOptions } from '../audio-capture';
import type { RuntimeAudioCommand } from '../../types/ipc';

type Listener = (...args: unknown[]) => void;

const actualAudioCapture = { ...await import('../audio-capture') };
let recording: RecordingOptions | null = null;
let finishStop: { resolve: (boundary: CaptureBoundary | null) => void; reject: (error: Error) => void } | null = null;
const cancelRecording = mock(() => {});

mock.module('../audio-capture', () => ({
  ...actualAudioCapture,
  setSelectedDeviceId: () => {},
  prepareStream: () => Promise.resolve(),
  enumerateDevices: () => Promise.resolve([]),
  startRecording: (options: RecordingOptions) => {
    recording = options;
    return Promise.resolve();
  },
  stopRecording: () => new Promise<CaptureBoundary | null>((resolve, reject) => {
    finishStop = { resolve, reject };
  }),
  cancelRecording,
}));

// Bun's mock.restore() does not undo mock.module replacements.
afterAll(() => {
  mock.module('../audio-capture', () => actualAudioCapture);
});

const { AudioWindow } = await import('../App');

const listeners: Record<string, Listener[]> = {};
const send = mock((..._args: unknown[]) => {});

function emit(channel: string, ...args: unknown[]) {
  for (const listener of listeners[channel] ?? []) listener(...args);
}

function command(sequence: number): RuntimeAudioCommand {
  return { generation: 1, recordingSessionId: `session-${sequence}`, sequence, streaming: false };
}

function sentOn(channel: string) {
  return send.mock.calls.filter((call: unknown[]) => call[0] === channel);
}

async function startThenDrain(first: RuntimeAudioCommand) {
  render(<AudioWindow />);
  await act(async () => emit('runtime:audio-start', first));
  await act(async () => emit('runtime:audio-stop', first));
  expect(finishStop).not.toBeNull();
}

beforeEach(() => {
  for (const key of Object.keys(listeners)) delete listeners[key];
  send.mockClear();
  cancelRecording.mockClear();
  recording = null;
  finishStop = null;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    subscribe: (channel: string, callback: Listener) => {
      (listeners[channel] ??= []).push(callback);
      return () => { listeners[channel] = (listeners[channel] ?? []).filter((l) => l !== callback); };
    },
    send,
    invoke: () => Promise.resolve({ selectedDeviceId: null }),
  };
});

afterEach(cleanup);

describe('AudioWindow stop drain ownership', () => {
  it('reports nothing for a draining stop that main cancelled', async () => {
    const first = command(1);
    await startThenDrain(first);

    await act(async () => emit('runtime:audio-cancel', first));
    await act(async () => finishStop!.resolve({ chunkCount: 3, sampleCount: 4800 }));

    expect(cancelRecording).toHaveBeenCalled();
    expect(sentOn('runtime:audio-end')).toEqual([]);
    expect(sentOn('runtime:audio-failed')).toEqual([]);
  });

  it('reports a processor failure while draining exactly once', async () => {
    const first = command(1);
    await startThenDrain(first);

    act(() => recording!.onFailure!(new Error('worklet crashed')));
    await act(async () => finishStop!.reject(new Error('worklet crashed')));

    expect(sentOn('runtime:audio-failed')).toEqual([['runtime:audio-failed', 1, 'session-1', 1]]);
    expect(sentOn('runtime:audio-end')).toEqual([]);
  });

  it('does not end a draining capture that a newer start replaced', async () => {
    const first = command(1);
    await startThenDrain(first);

    await act(async () => emit('runtime:audio-start', command(2)));
    await act(async () => finishStop!.resolve({ chunkCount: 3, sampleCount: 4800 }));

    expect(sentOn('runtime:audio-end')).toEqual([]);
    expect(sentOn('runtime:audio-failed')).toEqual([]);
  });
});
