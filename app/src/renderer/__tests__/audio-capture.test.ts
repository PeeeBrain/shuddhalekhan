import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { RecordingOptions } from '../audio-capture';

const vi = { fn: mock, mock: mock.module, spyOn };
import { enumerateDevices } from '../audio-capture';

const originalMediaDevices = navigator.mediaDevices;
const originalElectronAPI = window.electronAPI;

afterEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: originalMediaDevices,
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: originalElectronAPI,
  });
});

/** Collects what main would spool; asserts chunks arrive contiguously from 0. */
function recorder(extra: Partial<RecordingOptions> = {}) {
  const chunks: Uint8Array[] = [];
  const options: RecordingOptions = {
    onSpoolChunk: async (sequence, pcm) => {
      expect(sequence).toBe(chunks.length);
      chunks.push(pcm);
    },
    ...extra,
  };
  return {
    options,
    chunks,
    samples: () => chunks.flatMap((chunk) => Array.from(new Int16Array(chunk.buffer))),
  };
}

const pcm16 = (...sources: Float32Array[]) => sources.flatMap((source) => Array.from(source,
  (sample) => Math.trunc(sample < 0 ? sample * 0x8000 : sample * 0x7fff)));

describe('enumerateDevices', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        })),
        enumerateDevices: vi.fn(async () => [
          { deviceId: 'default', label: 'Default Mic', kind: 'audioinput' },
          { deviceId: 'speaker', label: 'Speaker', kind: 'audiooutput' },
          { deviceId: 'mic-2', label: 'USB Mic', kind: 'audioinput' },
        ]),
      },
    });
  });

  it('requests permission first so device labels are available and filters inputs', async () => {
    await expect(enumerateDevices()).resolves.toEqual([
      { deviceId: 'default', label: 'Default Mic', kind: 'audioinput' },
      { deviceId: 'mic-2', label: 'USB Mic', kind: 'audioinput' },
    ]);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it('returns an empty list when mediaDevices is unavailable', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(enumerateDevices()).resolves.toEqual([]);
    expect(error).toHaveBeenCalledWith('Media device enumeration is not available');
  });
});

type PortMessage = { type: 'audio'; samples: Float32Array } | { type: 'stopped' } | { type: 'overflow' };

/**
 * Fake Web Audio graph. The worklet port behaves like the real one: messages
 * are delivered asynchronously and in order, and `queued` audio (captured but
 * not yet delivered when stop is requested) arrives before the stop ack.
 */
function installAudio(acknowledgeStop = true, sampleRate = 16_000) {
  const stopTrack = vi.fn();
  const disconnect = vi.fn();
  const close = vi.fn(async () => undefined);
  const closePort = vi.fn();
  let contextState: AudioContextState = 'running';
  const resume = vi.fn(async () => { contextState = 'running'; });
  const send = vi.fn();
  const nodes: Array<{
    onprocessorerror: ((event: Event) => void) | null;
    port: { onmessage: ((event: { data: PortMessage }) => void) | null };
  }> = [];
  const queued: Float32Array[] = [];
  class MicrophoneTrack extends EventTarget {
    readyState = 'live';
    stop() { this.readyState = 'ended'; stopTrack(); }
    disconnect() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
  }
  const tracks: MicrophoneTrack[] = [];
  let credits = 0;
  let moduleGate: Promise<void> = Promise.resolve();
  const stream = () => {
    const track = new MicrophoneTrack();
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  const getUserMedia = vi.fn(async () => stream());

  const deliver = (data: PortMessage) => nodes.at(-1)?.port.onmessage?.({ data });

  Object.defineProperty(window, 'electronAPI', { configurable: true, writable: true, value: { send } });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    writable: true,
    value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
  });
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    writable: true,
    value: vi.fn(function AudioContext() {
      return {
        sampleRate,
        get state() { return contextState; },
        resume,
        audioWorklet: { addModule: vi.fn(() => moduleGate) },
        createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect })),
        close,
      };
    }),
  });
  Object.defineProperty(globalThis, 'AudioWorkletNode', {
    configurable: true,
    writable: true,
    value: vi.fn(function AudioWorkletNode() {
      const node = {
        onprocessorerror: null as ((event: Event) => void) | null,
        port: {
          close: closePort,
          onmessage: null as ((event: { data: PortMessage }) => void) | null,
          postMessage: (message: { type: string }) => {
            if (message.type === 'credit') credits += 1;
            if (message.type !== 'stop') return;
            if (!acknowledgeStop) return;
            void Promise.resolve().then(() => {
              for (const samples of queued.splice(0)) deliver({ type: 'audio', samples });
              deliver({ type: 'stopped' });
            });
          },
        },
        disconnect,
      };
      nodes.push(node);
      return node;
    }),
  });

  return {
    stopTrack,
    disconnect,
    close,
    closePort,
    resume,
    suspendContext: () => { contextState = 'suspended'; },
    send,
    getUserMedia,
    nodes,
    disconnectMic: () => tracks.at(-1)?.disconnect(),
    /** Audio the worklet captured but has not delivered yet. */
    queued,
    emit: (samples: Float32Array) => deliver({ type: 'audio', samples }),
    overflow: () => deliver({ type: 'overflow' }),
    /** Credits returned to the worklet so far. */
    credits: () => credits,
    holdMic: () => {
      let resolve: () => void = () => undefined;
      getUserMedia.mockImplementationOnce(() => new Promise((done) => {
        resolve = () => done(stream());
      }));
      return () => resolve();
    },
    holdModule: () => {
      let resolve: () => void = () => undefined;
      moduleGate = new Promise((done) => { resolve = done; });
      return () => resolve();
    },
  };
}

async function importFresh(): Promise<typeof import('../audio-capture')> {
  return import(`../audio-capture?fresh=${Date.now()}-${Math.random()}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('canonical PCM spool', () => {
  it('spools clamped PCM16 batches and declares exactly what it spooled', async () => {
    const audio = installAudio();
    const mod = await importFresh();
    const rec = recorder();
    await mod.startRecording(rec.options);
    audio.emit(new Float32Array([-1.5, -1, 0]));
    audio.emit(new Float32Array([0.25, 1, 2]));

    expect(await mod.stopRecording()).toEqual({ chunkCount: 2, sampleCount: 6 });
    expect(rec.samples()).toEqual([-32768, -32768, 0, 8191, 32767, 32767]);
  });

  it('resamples a 48 kHz context to 16 kHz at the conversion boundary', async () => {
    const audio = installAudio(true, 48_000);
    const mod = await importFresh();
    const rec = recorder();
    await mod.startRecording(rec.options);
    audio.emit(new Float32Array(960).fill(0.5));
    audio.emit(new Float32Array(2).fill(0.5)); // too short to yield a 16 kHz sample yet

    expect(await mod.stopRecording()).toEqual({ chunkCount: 1, sampleCount: 320 });
    expect(rec.samples()).toEqual(Array(320).fill(16383));
  });

  it('stops realtime frames at the credit bound while the spool keeps every sample', async () => {
    const audio = installAudio();
    const mod = await importFresh();
    const onPcmChunk = vi.fn();
    const onRealtimeDisabled = vi.fn();
    const source = new Float32Array(1000).fill(0.25);
    const rec = recorder({
      streaming: { recordingSessionId: 'slow', maxInFlightChunks: 1, onPcmChunk, onRealtimeDisabled },
    });
    await mod.startRecording(rec.options);
    audio.emit(source);

    expect(await mod.stopRecording()).toEqual({ chunkCount: 1, sampleCount: 1000 });
    expect(onPcmChunk).toHaveBeenCalledTimes(1);
    expect(onRealtimeDisabled).toHaveBeenCalledTimes(1);
    expect(rec.samples()).toEqual(pcm16(source));
  });
});

describe('bounded spool transport', () => {
  it('releases the microphone and reports once on disconnect, ignores old track events, and records again', async () => {
    const audio = installAudio();
    const mod = await importFresh();
    const failed = vi.fn();
    const rec = recorder({ onFailure: failed });
    await mod.startRecording(rec.options);
    audio.emit(new Float32Array([0.2]));
    audio.disconnectMic();
    audio.disconnectMic();
    audio.emit(new Float32Array([0.8]));
    await settle();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('microphone disconnected') }));
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);
    expect(audio.close).toHaveBeenCalledTimes(1);
    expect(rec.chunks).toHaveLength(1);

    await mod.startRecording(recorder({ onFailure: failed }).options);
    audio.emit(new Float32Array([0.4]));
    await expect(mod.stopRecording()).resolves.toEqual({ chunkCount: 1, sampleCount: 1 });
    audio.disconnectMic();
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('reports disconnection while worklet startup is pending and never creates a late node', async () => {
    const audio = installAudio();
    const releaseModule = audio.holdModule();
    const mod = await importFresh();
    const failed = vi.fn();
    const starting = mod.startRecording(recorder({ onFailure: failed }).options);
    await settle();
    audio.disconnectMic();
    await settle();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);
    releaseModule();
    await starting;
    expect(audio.nodes).toHaveLength(0);
  });

  it('rejects an acknowledged stop if the microphone disconnects before spool writes are confirmed', async () => {
    const audio = installAudio();
    const mod = await importFresh();
    const failed = vi.fn();
    let confirm = () => undefined as void;
    await mod.startRecording({ onSpoolChunk: () => new Promise<void>(resolve => { confirm = resolve; }), onFailure: failed });
    audio.emit(new Float32Array([0.3]));
    const stopping = mod.stopRecording();
    await settle();
    audio.disconnectMic();
    await expect(stopping).rejects.toThrow('microphone disconnected');
    confirm();
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('returns a worklet credit only once main confirms the write, and stop waits for that confirmation', async () => {
    const audio = installAudio();
    const mod = await importFresh();
    let confirm = () => undefined as void;
    await mod.startRecording({ onSpoolChunk: () => new Promise<void>((done) => { confirm = done; }) });
    audio.emit(new Float32Array([0.25]));
    await settle();
    expect(audio.credits()).toBe(0);

    const ending = mod.stopRecording();
    await settle();
    expect(audio.close).not.toHaveBeenCalled();
    confirm();
    expect(await ending).toEqual({ chunkCount: 1, sampleCount: 1 });
    expect(audio.credits()).toBe(1);
  });

  it('fails stop and releases the microphone when main never confirms a write', async () => {
    const audio = installAudio();
    const mod = await importFresh();
    const realSetTimeout = globalThis.setTimeout;
    // Skip the real write-ack deadline; other timers keep their delays.
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) =>
      realSetTimeout(callback, ms === 2_000 ? 0 : ms)) as typeof setTimeout);
    try {
      await mod.startRecording({ onSpoolChunk: () => new Promise<void>(() => undefined) });
      audio.emit(new Float32Array([0.25]));
      await expect(mod.stopRecording()).rejects.toThrow('did not confirm spooled audio');
    } finally {
      timeout.mockRestore();
    }
    expect(audio.close).toHaveBeenCalledTimes(1);
    await settle();
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the worklet runs out of credits', (audio: ReturnType<typeof installAudio>) => audio.overflow()],
    ['main refuses a write', (audio: ReturnType<typeof installAudio>) => audio.emit(new Float32Array([0.25]))],
  ] as const)('fails capture and releases the microphone when %s, then records afresh', async (
    _reason: string,
    trigger: (audio: ReturnType<typeof installAudio>) => void,
  ) => {
    const audio = installAudio();
    const mod = await importFresh();
    const failed = vi.fn();
    await mod.startRecording({
      onSpoolChunk: async () => { throw new Error('Main did not spool audio chunk 0.'); },
      onFailure: failed,
    });
    trigger(audio);
    await settle();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(audio.close).toHaveBeenCalledTimes(1);
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);

    const rec = recorder();
    await mod.startRecording(rec.options);
    audio.emit(new Float32Array([0.5]));
    expect(await mod.stopRecording()).toEqual({ chunkCount: 1, sampleCount: 1 });
  });
});

describe('recording lifecycle', () => {
  it('resumes a suspended audio context before declaring capture started', async () => {
    const audio = installAudio();
    audio.suspendContext();
    const mod = await importFresh();
    await mod.startRecording(recorder().options);
    expect(audio.resume).toHaveBeenCalledTimes(1);
    audio.emit(new Float32Array([0.25]));
    expect(await mod.stopRecording()).toEqual({ chunkCount: 1, sampleCount: 1 });
    expect(audio.closePort).toHaveBeenCalledTimes(1);
  });

  it('reports processor failure immediately, releases the microphone, and can start a fresh capture', async () => {
    const audio = installAudio();
    const mod = await importFresh();
    const failed = vi.fn();
    await mod.startRecording(recorder({ onFailure: failed }).options);
    audio.nodes[0].onprocessorerror?.(new Event('processorerror'));
    expect(failed).toHaveBeenCalledTimes(1);
    expect(audio.close).toHaveBeenCalledTimes(1);
    expect(audio.closePort).toHaveBeenCalledTimes(1);
    await settle();
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);
    await mod.startRecording(recorder().options);
    audio.emit(new Float32Array([0.5]));
    expect(await mod.stopRecording()).toEqual({ chunkCount: 1, sampleCount: 1 });
  });

  it('rejects a draining capture if its processor crashes before acknowledging stop', async () => {
    const audio = installAudio(false);
    const mod = await importFresh();
    const failed = vi.fn();
    await mod.startRecording(recorder({ onFailure: failed }).options);
    const ending = mod.stopRecording();
    await Promise.resolve();
    audio.nodes[0].onprocessorerror?.(new Event('processorerror'));
    await expect(ending).rejects.toThrow('audio processor failed');
    expect(failed).toHaveBeenCalledTimes(1);
    expect(audio.closePort).toHaveBeenCalledTimes(1);
  });

  it('fails capture and releases the microphone when the worklet never confirms its final boundary', async () => {
    const audio = installAudio(false);
    const mod = await importFresh();
    await mod.startRecording(recorder().options);
    audio.emit(new Float32Array([0.25]));
    await expect(mod.stopRecording()).rejects.toThrow('did not acknowledge stopping');
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);
    expect(audio.close).toHaveBeenCalledTimes(1);
  });

  it('cancels audio that has already detached for draining without declaring a boundary', async () => {
    const audio = installAudio();
    const mod = await importFresh();
    const onPcmChunk = vi.fn();
    const rec = recorder({ streaming: { recordingSessionId: 'cancel-drain', maxInFlightChunks: 50,
      onPcmChunk, onRealtimeDisabled: vi.fn() } });
    await mod.startRecording(rec.options);
    audio.queued.push(new Float32Array([0.25]));
    const ending = mod.stopRecording();
    mod.cancelRecording();
    expect(await ending).toBeNull();
    expect(onPcmChunk).not.toHaveBeenCalled();
    expect(rec.chunks).toHaveLength(0);
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);
  });

  it('drains audio queued in the worklet before stop into the spool and final realtime frame exactly once', async () => {
    const audio = installAudio();
    const mod = await importFresh();
    const chunks: Array<[number, number]> = [];
    const head = new Float32Array(640).fill(0.25);
    const tail = new Float32Array(100).fill(-0.5);

    mod.setSelectedDeviceId('mic-123');
    const rec = recorder({ streaming: {
      recordingSessionId: 'capture-session',
      maxInFlightChunks: 50,
      onPcmChunk: (chunk) => chunks.push([chunk.sequence, chunk.pcm.byteLength]),
      onRealtimeDisabled: vi.fn(),
    } });
    await mod.startRecording(rec.options);
    audio.emit(head);
    audio.queued.push(tail);
    const boundary = await mod.stopRecording();

    expect(audio.getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({ advanced: [{ deviceId: { exact: 'mic-123' } }] }) as MediaTrackConstraints,
    });
    expect(chunks).toEqual([[0, 640], [1, 640], [2, 200]]);
    expect(boundary).toEqual({ chunkCount: 2, sampleCount: 740 });
    expect(rec.samples()).toEqual(pcm16(head, tail));
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);
    expect(audio.disconnect).toHaveBeenCalledTimes(2);
    expect(audio.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['microphone permission', 'holdMic'],
    ['worklet module load', 'holdModule'],
  ] as const)('cancel during pending %s never starts capture and releases its resources', async (_reason: string, hold: 'holdMic' | 'holdModule') => {
    const audio = installAudio();
    const mod = await importFresh();
    const release = audio[hold]();
    const onPcmChunk = vi.fn();

    const starting = mod.startRecording(recorder({
      streaming: { recordingSessionId: 'stale', maxInFlightChunks: 50, onPcmChunk, onRealtimeDisabled: vi.fn() },
    }).options);
    mod.cancelRecording();
    release();
    await starting;
    await settle();

    expect(audio.nodes).toHaveLength(0);
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);
    expect(audio.close).toHaveBeenCalledTimes(1);
    expect(onPcmChunk).not.toHaveBeenCalled();

    // The next recording is not blocked by the cancelled one.
    await mod.startRecording(recorder().options);
    expect(audio.nodes).toHaveLength(1);
    audio.emit(new Float32Array([0.25]));
    expect(await mod.stopRecording()).toEqual({ chunkCount: 1, sampleCount: 1 });
  });

  it('cancel while recording stops tracks and drops any later worklet audio', async () => {
    const audio = installAudio();
    const mod = await importFresh();
    const onPcmChunk = vi.fn();
    const rec = recorder({
      streaming: { recordingSessionId: 'cancelled', maxInFlightChunks: 50, onPcmChunk, onRealtimeDisabled: vi.fn() },
    });
    await mod.startRecording(rec.options);
    const port = audio.nodes[0]?.port;
    const lateHandler = port?.onmessage;

    mod.cancelRecording();
    lateHandler?.({ data: { type: 'audio', samples: new Float32Array(640).fill(0.5) } });
    await settle();

    expect(onPcmChunk).not.toHaveBeenCalled();
    expect(rec.chunks).toHaveLength(0);
    expect(port?.onmessage).toBeNull();
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);
    expect(audio.close).toHaveBeenCalledTimes(1);
  });

  it('keeps a running recording on its microphone when the device changes', async () => {
    const audio = installAudio();
    const mod = await importFresh();
    mod.setSelectedDeviceId('mic-1');
    await mod.startRecording(recorder().options);
    audio.emit(new Float32Array([0.25, 0.25]));

    await mod.recreateStream('mic-2');
    // Only the short-lived permission probe for mic-2 is stopped.
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);
    expect(audio.close).not.toHaveBeenCalled();
    audio.emit(new Float32Array([0.5]));

    expect(await mod.stopRecording()).toEqual({ chunkCount: 2, sampleCount: 3 });
    expect(audio.getUserMedia).toHaveBeenLastCalledWith({
      audio: expect.objectContaining({ advanced: [{ deviceId: { exact: 'mic-2' } }] }) as MediaTrackConstraints,
    });
  });

  it.each([
    ['microphone permission', 'holdMic'],
    ['worklet module load', 'holdModule'],
  ] as const)('fails a %s that never settles and stops tracks the late mic delivers', async (_reason: string, hold: 'holdMic' | 'holdModule') => {
    const audio = installAudio();
    const mod = await importFresh();
    const releaseHold = audio[hold]();
    const realSetTimeout = globalThis.setTimeout;
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) =>
      realSetTimeout(callback, ms === 30_000 ? 0 : ms)) as typeof setTimeout);
    try {
      const results = Promise.allSettled([mod.startRecording(recorder().options), mod.stopRecording()]);
      for (const result of await results) {
        expect(result.status === 'rejected' && String(result.reason)).toContain('did not start in time');
      }
    } finally {
      timeout.mockRestore();
    }
    expect(audio.close).toHaveBeenCalledTimes(1);
    releaseHold();
    await settle();
    expect(audio.nodes).toHaveLength(0);
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);
    // A late mic never marks permission preparation as complete.
    await mod.prepareStream();
    expect(audio.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('stops microphone tracks when setup fails after acquisition', async () => {
    const audio = installAudio();
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      writable: true,
      value: vi.fn(() => {
        throw new Error('Audio context failed');
      }),
    });
    const mod = await importFresh();

    await expect(mod.startRecording(recorder().options)).rejects.toThrow('Audio context failed');
    await settle();
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);
  });
});

describe('warm audio stream', () => {
  it('prepares microphone permission once and opens a fresh capture stream per recording', async () => {
    const audio = installAudio();
    const mod = await importFresh();
    mod.setSelectedDeviceId('mic-123');

    await mod.prepareStream();
    expect(audio.getUserMedia).toHaveBeenCalledTimes(1);
    expect(audio.nodes).toHaveLength(0);
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);

    await mod.startRecording(recorder().options);
    expect(audio.getUserMedia).toHaveBeenCalledTimes(2);
    audio.emit(new Float32Array([0.2, -0.4, 0.6]));
    audio.emit(new Float32Array([0.2, -0.4, 0.6]));

    expect(await mod.stopRecording()).toEqual({ chunkCount: 2, sampleCount: 6 });
    expect(audio.stopTrack).toHaveBeenCalledTimes(2);
    expect(audio.close).toHaveBeenCalledTimes(1);

    await mod.startRecording(recorder().options);
    expect(audio.getUserMedia).toHaveBeenCalledTimes(3);
    await mod.stopRecording();
    expect(audio.stopTrack).toHaveBeenCalledTimes(3);
    expect(audio.close).toHaveBeenCalledTimes(2);
  });

  it('builds the audio context while the microphone is opening', async () => {
    const audio = installAudio();
    const releaseMic = audio.holdMic();
    const mod = await importFresh();

    const starting = mod.startRecording(recorder().options);
    expect(AudioContext).toHaveBeenCalledTimes(1);

    releaseMic();
    await starting;
    await mod.stopRecording();
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);
  });

  it('throttles recording pill level telemetry without dropping captured audio chunks or emitting duration updates', async () => {
    const audio = installAudio();
    const intervalCallbacks: Array<() => void> = [];
    const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation((callback: () => void) => {
      intervalCallbacks.push(callback);
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const mod = await importFresh();

    try {
      await mod.startRecording(recorder().options);
      expect(intervalCallbacks).toHaveLength(1);

      for (let index = 0; index < 4; index += 1) audio.emit(new Float32Array([0.2, -0.4, 0.6]));
      intervalCallbacks.forEach((callback) => callback());

      const boundary = await mod.stopRecording();
      const telemetryCalls = audio.send.mock.calls.filter(([channel]: [string, ...unknown[]]) =>
        channel === 'audio-level-changed' || channel === 'audio-duration-changed'
      );

      expect(telemetryCalls).toEqual([
        ['audio-level-changed', 0],
        ['audio-level-changed', expect.closeTo(1)],
      ]);
      expect(boundary).toEqual({ chunkCount: 4, sampleCount: 12 });
      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      intervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('re-prepares microphone permission with the new device on device change', async () => {
    const audio = installAudio();
    const mod = await importFresh();
    mod.setSelectedDeviceId('mic-1');

    await mod.prepareStream();
    expect(audio.getUserMedia).toHaveBeenCalledTimes(1);

    await mod.recreateStream('mic-2');

    expect(audio.stopTrack).toHaveBeenCalledTimes(2);
    expect(audio.close).not.toHaveBeenCalled();
    expect(audio.getUserMedia).toHaveBeenCalledTimes(2);
    expect(audio.getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: expect.objectContaining({
        advanced: [{ deviceId: { exact: 'mic-2' } }],
        sampleRate: 16000,
      }) as MediaTrackConstraints,
    });
  });
});
