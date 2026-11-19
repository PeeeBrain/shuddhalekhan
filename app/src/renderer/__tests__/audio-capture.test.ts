import { BAND_COUNT, readBands, subscribeAudioLevel } from '../audio-level';
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

type PortMessage = { type: 'audio'; samples: Float32Array } | { type: 'started'; samples: Float32Array; late: number }
  | { type: 'stopped' } | { type: 'overflow' };

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
  /** Start commands the worklet received. */
  const starts: Array<{ preRollFrames?: number; pressFrame?: number | null }> = [];
  /** What the worklet heard while idle; `start` hands out its newest frames. */
  let ring: Float32Array = new Float32Array(0);
  /** The physical device behind the system default; new tracks open on it. */
  let defaultMic = 'mic-a';
  class MicrophoneTrack extends EventTarget {
    readyState = 'live';
    readonly label = `Default - ${defaultMic}`;
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
    value: Object.assign(new EventTarget(), {
      getUserMedia,
      // Chromium on Windows reports one groupId for every input, so it can't tell mics apart.
      enumerateDevices: vi.fn(async () => [{ kind: 'audioinput', deviceId: 'default', groupId: 'all', label: `Default - ${defaultMic}` }]),
    }),
  });
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    writable: true,
    value: vi.fn(function AudioContext() {
      return {
        sampleRate,
        currentTime: 2,
        get state() { return contextState; },
        resume,
        audioWorklet: { addModule: vi.fn(() => moduleGate) },
        createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect })),
        // A mic holding one 300 Hz tone, so the pill's bands have something to find.
        createAnalyser: vi.fn(() => ({
          fftSize: 512,
          frequencyBinCount: 256,
          context: { sampleRate: 16_000 },
          connect: vi.fn(),
          getFloatFrequencyData: (db: Float32Array) => {
            db.fill(-120);
            db[Math.round(300 / (16_000 / 512))] = -30;
          },
        })),
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
          postMessage: (message: { type: string; preRollFrames?: number; pressFrame?: number | null }) => {
            if (message.type === 'credit') credits += 1;
            if (message.type === 'start') {
              starts.push(message);
              const samples = ring.slice(Math.max(0, ring.length - (message.preRollFrames ?? 0)));
              ring = new Float32Array(0);
              void Promise.resolve().then(() => deliver({ type: 'started', samples, late: 0 }));
              return;
            }
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
    /** The OS device list changed, with the system default now on `mic`. */
    changeDevices: (mic: string) => {
      defaultMic = mic;
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    },
    /** Audio the worklet captured but has not delivered yet. */
    queued,
    starts,
    hearWhileIdle: (samples: Float32Array) => { ring = samples; },
    tracks,
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

describe('release tail', () => {
  const speech = () => new Float32Array(320).fill(0.2);
  const quiet = () => new Float32Array(320).fill(0.001);

  /** `ms` of 16 kHz audio at a constant level. */
  const batch = (ms: number, level: number) => new Float32Array(ms * 16).fill(level);

  async function stopWithTail(maxTailMs: number) {
    const audio = installAudio();
    const mod = await importFresh();
    const rec = recorder();
    await mod.startRecording(rec.options);
    audio.emit(speech());
    let boundary: Awaited<ReturnType<typeof mod.stopRecording>> | undefined;
    const ending = mod.stopRecording(Date.now() + maxTailMs).then((value) => { boundary = value; return value; });
    ending.catch(() => undefined);
    /** Delivers one batch after release; returns whether stop has finished. */
    const feed = async (samples: Float32Array) => {
      audio.emit(samples);
      await settle();
      return boundary !== undefined;
    };
    return { audio, mod, rec, feed, ending };
  }

  it('keeps a final word that continues past release in the same contiguous spool, then ends on quiet', async () => {
    const word = batch(100, 0.2);
    const softer = batch(150, 0.03); // a quieter final syllable still counts as speech
    const pause = batch(100, 0.001);
    const rest = batch(60, 0.001);
    const { rec, feed, ending } = await stopWithTail(600);
    expect(await feed(word)).toBe(false);
    expect(await feed(softer)).toBe(false); // 250 ms in: past the base tail, still talking
    expect(await feed(pause)).toBe(false);
    expect(await feed(rest)).toBe(true); // 160 ms of quiet

    expect(await ending).toEqual({ chunkCount: 5, sampleCount: 320 + 410 * 16 });
    expect(rec.samples()).toEqual(pcm16(speech(), word, softer, pause, rest));
  });

  it('measures the tail in audio received, so a burst after a stalled renderer still keeps the full tail', async () => {
    const { feed } = await stopWithTail(600);
    // Batches arrive late and back to back; each is only 20 ms of audio.
    for (let i = 0; i < 9; i += 1) expect(await feed(quiet())).toBe(false);
    expect(await feed(quiet())).toBe(true); // 200 ms of audio
  });

  it('a Stop that arrives after its tail end time keeps no tail', async () => {
    const audio = installAudio();
    const mod = await importFresh();
    await mod.startRecording(recorder().options);
    audio.emit(speech());
    expect(await mod.stopRecording(Date.now() - 1)).toEqual({ chunkCount: 1, sampleCount: 320 });
  });

  it('ends a quiet release at the base tail and never past the cap main passes', async () => {
    const base = await stopWithTail(600);
    expect(await base.feed(batch(100, 0.001))).toBe(false);
    expect(await base.feed(batch(100, 0.001))).toBe(true);

    const capped = await stopWithTail(60);
    expect(await capped.feed(batch(50, 0.2))).toBe(false);
    // Batches stop arriving: the cap's own deadline still finishes the recording.
    expect(await capped.ending).toEqual({ chunkCount: 2, sampleCount: 320 + 800 });
  });

  it('cancel during the tail discards it, and the next recording gets none of its samples', async () => {
    const { audio, mod, rec, ending } = await stopWithTail(600);
    const staleHandler = audio.nodes[0]?.port.onmessage;
    mod.cancelRecording();
    expect(await ending).toBeNull();
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);

    const next = recorder();
    await mod.startRecording(next.options);
    staleHandler?.({ data: { type: 'audio', samples: speech() } });
    audio.emit(quiet());
    expect(await mod.stopRecording()).toEqual({ chunkCount: 1, sampleCount: 320 });
    expect(next.samples()).toEqual(pcm16(quiet()));
    expect(rec.chunks).toHaveLength(1);
  });

  it('fails the stop and releases the microphone if it disconnects during the tail', async () => {
    const { audio, ending } = await stopWithTail(600);
    audio.disconnectMic();
    await expect(ending).rejects.toThrow('microphone disconnected');
    expect(audio.close).toHaveBeenCalledTimes(1);
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
  it('feeds the pill the live mic spectrum only while a capture is running', async () => {
    installAudio();
    const mod = await importFresh();
    const bands = new Float32Array(BAND_COUNT);
    expect(readBands(bands)).toBe(false);

    await mod.startRecording(recorder().options);
    expect(readBands(bands)).toBe(true);
    expect(bands.indexOf(1)).toBeLessThan(BAND_COUNT / 2);

    await mod.stopRecording();
    expect(readBands(bands)).toBe(false);
  });

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
    // mic-2 is not even probed until the take ends.
    expect(audio.getUserMedia).toHaveBeenCalledTimes(1);
    expect(audio.close).not.toHaveBeenCalled();
    audio.emit(new Float32Array([0.5]));

    expect(await mod.stopRecording()).toEqual({ chunkCount: 2, sampleCount: 3 });
    await mod.startRecording(recorder().options);
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

  it('never opens the microphone when the audio context cannot be built', async () => {
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
    expect(audio.getUserMedia).not.toHaveBeenCalled();
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
      const levels: number[] = [];
      const offLevel = subscribeAudioLevel((level) => levels.push(level));
      await mod.startRecording(recorder().options);
      expect(intervalCallbacks).toHaveLength(1);

      for (let index = 0; index < 4; index += 1) audio.emit(new Float32Array([0.2, -0.4, 0.6]));
      intervalCallbacks.forEach((callback) => callback());

      const boundary = await mod.stopRecording();
      offLevel();
      expect(levels).toEqual([0, expect.closeTo(1)]);
      expect(audio.send).not.toHaveBeenCalled();
      expect(boundary).toEqual({ chunkCount: 4, sampleCount: 12 });
      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      intervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  describe('opted in', () => {
    /** 450 ms at 16 kHz: what the ring hands the next recording. */
    const PRE_ROLL = 7200;
    const idle = () => Float32Array.from({ length: 16_000 }, (_, index) => (index % 100) / 1000);

    async function parked() {
      const audio = installAudio();
      const mod = await importFresh();
      mod.setWarmMicrophone(true);
      await settle();
      return { audio, mod };
    }

    it('heads the next recording with the last 450 ms before the press, on the mic it kept open', async () => {
      const { audio, mod } = await parked();
      expect(audio.getUserMedia).toHaveBeenCalledTimes(1);
      const heard = idle();
      audio.hearWhileIdle(heard);
      const rec = recorder({ pressedAt: Date.now() });
      expect((await mod.startRecording(rec.options)).preRollSamples).toBe(PRE_ROLL);
      const speech = new Float32Array(320).fill(0.2);
      audio.emit(speech);

      expect(await mod.stopRecording()).toEqual({ chunkCount: 2, sampleCount: PRE_ROLL + 320 });
      expect(rec.samples()).toEqual(pcm16(heard.slice(-PRE_ROLL), speech));
      // Parked again, not reopened.
      expect(audio.stopTrack).not.toHaveBeenCalled();
      // Agent Mode takes the warm mic but none of its pre-roll.
      audio.hearWhileIdle(idle());
      expect((await mod.startRecording(recorder().options)).preRollSamples).toBe(0);
      expect(await mod.stopRecording()).toEqual({ chunkCount: 0, sampleCount: 0 });
      expect(audio.getUserMedia).toHaveBeenCalledTimes(1);

      mod.setWarmMicrophone(false);
      await settle();
      expect(audio.stopTrack).toHaveBeenCalledTimes(1);
      expect(audio.close).toHaveBeenCalledTimes(1);
    });

    it("places the press at main's hotkey time on the audio clock, not when the command arrived", async () => {
      const { audio, mod } = await parked();
      const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
      try {
        // The renderer acted 100 ms after the hotkey; the context clock reads 2 s.
        await mod.startRecording(recorder({ pressedAt: 9_900 }).options);
      } finally {
        now.mockRestore();
      }
      expect(audio.starts.at(-1)?.pressFrame).toBe(30_400);
      await mod.stopRecording();
      mod.setWarmMicrophone(false);
    });

    it('keeps a soft final word after release even when the pre-roll was loud', async () => {
      const { audio, mod } = await parked();
      audio.hearWhileIdle(new Float32Array(16_000).fill(0.9)); // media playing before the press
      await mod.startRecording(recorder({ pressedAt: Date.now() }).options);
      audio.emit(new Float32Array(320).fill(0.2));
      let done = false;
      const ending = mod.stopRecording(Date.now() + 60_000).then((boundary) => { done = true; return boundary; });
      await settle(); // the release-tail listener is now hearing
      audio.emit(new Float32Array(250 * 16).fill(0.03)); // 250 ms of a softer syllable
      await settle();
      expect(done).toBe(false);
      audio.emit(new Float32Array(250 * 16).fill(0.001));
      expect(await ending).toEqual({ chunkCount: 4, sampleCount: PRE_ROLL + 320 + 500 * 16 });
      mod.setWarmMicrophone(false);
    });

    it('hands over no ring from a mic still opening at the press', async () => {
      // Its ring is startup audio from after the press, maybe a cue: neither is pre-roll.
      const audio = installAudio();
      const mod = await importFresh();
      const open = audio.holdMic();
      mod.setWarmMicrophone(true);
      const starting = mod.startRecording(recorder({ pressedAt: Date.now() }).options);
      audio.hearWhileIdle(idle());
      open();
      expect((await starting).preRollSamples).toBe(0);
      expect(await mod.stopRecording()).toEqual({ chunkCount: 0, sampleCount: 0 });
      mod.setWarmMicrophone(false);
    });

    it('keeps a recording cue out of the pre-roll until it has sounded, however late', async () => {
      const now = vi.spyOn(performance, 'now').mockReturnValue(0);
      try {
        const { audio, mod } = await parked();
        audio.hearWhileIdle(idle());
        const silent = mod.holdPreRollForCue();
        // Still not sounded five seconds later: its output woke late.
        now.mockReturnValue(5_000);
        expect((await mod.startRecording(recorder({ pressedAt: Date.now() }).options)).preRollSamples).toBe(0);
        audio.emit(new Float32Array([0.2]));
        expect(await mod.stopRecording()).toEqual({ chunkCount: 1, sampleCount: 1 });

        // 400 ms after it fell silent, only the 50 ms past its output latency is pre-roll.
        silent();
        now.mockReturnValue(5_400);
        audio.hearWhileIdle(idle());
        expect((await mod.startRecording(recorder({ pressedAt: Date.now() }).options)).preRollSamples).toBe(800);
      } finally {
        now.mockRestore();
      }
    });

    it('does not reopen a mic whose stop timed out', async () => {
      const audio = installAudio(false);
      const mod = await importFresh();
      mod.setWarmMicrophone(true);
      await settle();
      await mod.startRecording(recorder().options);
      await expect(mod.stopRecording()).rejects.toThrow('did not acknowledge stopping');
      await settle();
      expect(audio.stopTrack).toHaveBeenCalledTimes(1);
      expect(audio.getUserMedia).toHaveBeenCalledTimes(1);
    });

    it('does not reopen a mic cancelled before it opened', async () => {
      // Main's startup deadline cancels a recording whose mic never opened.
      const audio = installAudio();
      const mod = await importFresh();
      const open = audio.holdMic();
      mod.setWarmMicrophone(true);
      const starting = mod.startRecording(recorder().options);
      mod.cancelRecording();
      open();
      expect((await starting).preRollSamples).toBe(0);
      await settle();
      expect(audio.stopTrack).toHaveBeenCalledTimes(1);
      expect(audio.getUserMedia).toHaveBeenCalledTimes(1);
    });

    it('does not reopen a mic cancelled while its audio was still resuming', async () => {
      const audio = installAudio();
      const mod = await importFresh();
      audio.suspendContext();
      audio.resume.mockImplementationOnce(() => new Promise(() => undefined));
      mod.setWarmMicrophone(true);
      void mod.startRecording(recorder().options).catch(() => undefined);
      await settle();
      expect(audio.nodes).toHaveLength(1);
      mod.cancelRecording();
      await settle();
      expect(audio.stopTrack).toHaveBeenCalledTimes(1);
      expect(audio.getUserMedia).toHaveBeenCalledTimes(1);
    });

    it('closes a parked mic whose audio never finishes starting', async () => {
      const audio = installAudio();
      const mod = await importFresh();
      audio.suspendContext();
      audio.resume.mockImplementationOnce(() => new Promise(() => undefined));
      const timers = vi.spyOn(globalThis, 'setTimeout');
      try {
        mod.setWarmMicrophone(true);
        await settle();
        expect(audio.nodes).toHaveLength(1);
        expect(audio.stopTrack).not.toHaveBeenCalled();
        const calls: unknown[][] = timers.mock.calls;
        const deadline = calls.find(([, ms]) => ms === 30_000)?.[0] as () => void;
        deadline();
      } finally {
        timers.mockRestore();
      }
      await settle();
      expect(audio.stopTrack).toHaveBeenCalledTimes(1);
      mod.setWarmMicrophone(false);
    });

    it('does not reopen a parked mic that closed while a device change was checking it', async () => {
      const audio = installAudio();
      const mod = await importFresh();
      const open = audio.holdMic();
      const timers = vi.spyOn(globalThis, 'setTimeout');
      try {
        mod.setWarmMicrophone(true);
        audio.changeDevices('mic-b');
        await settle();
        // The idle setup deadline closes it while the check waits on its stream.
        const calls: unknown[][] = timers.mock.calls;
        const deadline = calls.find(([, ms]) => ms === 30_000)?.[0] as () => void;
        deadline();
      } finally {
        timers.mockRestore();
      }
      open();
      await settle();
      expect(audio.getUserMedia).toHaveBeenCalledTimes(1);
      mod.setWarmMicrophone(false);
    });

    it('closes the mic on cancel so the dropped utterance never becomes pre-roll', async () => {
      const { audio, mod } = await parked();
      await mod.startRecording(recorder().options);
      audio.emit(new Float32Array(320).fill(0.2));
      mod.cancelRecording();
      await settle();
      expect(audio.stopTrack).toHaveBeenCalledTimes(1);
      expect(audio.close).toHaveBeenCalledTimes(1);
      // A fresh mic, with a fresh ring, is kept ready instead.
      expect(audio.getUserMedia).toHaveBeenCalledTimes(2);
    });

    it('reopens on the new device when the system default changes', async () => {
      const { audio, mod } = await parked();
      audio.changeDevices('mic-b');
      await settle();
      expect(audio.stopTrack).toHaveBeenCalledTimes(1);
      expect(audio.getUserMedia).toHaveBeenCalledTimes(2);
      expect(audio.tracks.at(-1)?.label).toBe('Default - mic-b');
      mod.setWarmMicrophone(false);
    });

    it('opens a newly chosen mic once while idle, not again to probe it', async () => {
      const { audio, mod } = await parked();
      await mod.recreateStream('mic-2');
      expect(audio.getUserMedia).toHaveBeenCalledTimes(2);
      expect(audio.tracks.at(-1)?.readyState).toBe('live');
      mod.setWarmMicrophone(false);
    });

    it('keeps the parked mic when the device list changes but its device does not', async () => {
      // Another device plugged in.
      const { audio, mod } = await parked();
      audio.changeDevices('mic-a');
      await settle();
      expect(audio.stopTrack).not.toHaveBeenCalled();
      expect(audio.getUserMedia).toHaveBeenCalledTimes(1);
      mod.setWarmMicrophone(false);
    });

    it('keeps the parked mic when the device list cannot be read', async () => {
      const { audio, mod } = await parked();
      (navigator.mediaDevices.enumerateDevices as ReturnType<typeof mock>).mockRejectedValueOnce(new Error('busy'));
      audio.changeDevices('mic-a');
      await settle();
      expect(audio.stopTrack).not.toHaveBeenCalled();
      mod.setWarmMicrophone(false);
    });

    it('finishes a recording on the old mic when a new one is chosen, then keeps the new one ready', async () => {
      const { audio, mod } = await parked();
      await mod.startRecording(recorder().options);
      await mod.recreateStream('mic-2');
      // Nothing opens the new mic while the take is still recording.
      expect(audio.getUserMedia).toHaveBeenCalledTimes(1);
      expect(audio.tracks[0]?.readyState).toBe('live');
      await mod.stopRecording();
      await settle();
      expect(audio.tracks[0]?.readyState).toBe('ended');
      expect(audio.getUserMedia).toHaveBeenLastCalledWith({
        audio: expect.objectContaining({ advanced: [{ deviceId: { exact: 'mic-2' } }] }) as MediaTrackConstraints,
      });
      expect(audio.tracks.at(-1)?.readyState).toBe('live');
      mod.setWarmMicrophone(false);
    });

    it('releases a parked mic that disconnects and does not reopen it until the next recording', async () => {
      const { audio, mod } = await parked();
      audio.disconnectMic();
      expect(audio.close).toHaveBeenCalledTimes(1);
      // Nor when the device list then changes, as it does for an unplug.
      audio.changeDevices('mic-a');
      await settle();
      expect(audio.getUserMedia).toHaveBeenCalledTimes(1);

      expect((await mod.startRecording(recorder().options)).preRollSamples).toBe(0);
      expect(audio.getUserMedia).toHaveBeenCalledTimes(2);
      mod.setWarmMicrophone(false);
      await mod.stopRecording();
      expect(audio.close).toHaveBeenCalledTimes(2);
    });
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
