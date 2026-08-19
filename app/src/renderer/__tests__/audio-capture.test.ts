import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const vi = { fn: mock, mock: mock.module, spyOn };
import {
  __audioCaptureTestUtils,
  enumerateDevices,
  setSelectedDeviceId,
  startRecording,
  stopRecording,
} from '../audio-capture';

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

describe('audio capture helpers', () => {
  it('emits ordered 20 ms PCM16 frames and builds the final WAV from the same samples', () => {
    const source = Float32Array.from({ length: 640 }, (_, index) => (index - 320) / 320);
    const capture = __audioCaptureTestUtils.createStreamingCapture({
      recordingSessionId: 'utterance-1',
      maxInFlightChunks: 2,
    });

    const first = capture.push([source.slice(0, 500)], 16_000);
    const second = capture.push([source.slice(500)], 16_000);

    expect(first).toEqual([{
      recordingSessionId: 'utterance-1',
      sequence: 0,
      pcm: expect.any(Uint8Array),
    }]);
    expect(first[0]?.pcm.byteLength).toBe(640);
    expect(second).toEqual([{
      recordingSessionId: 'utterance-1',
      sequence: 1,
      pcm: expect.any(Uint8Array),
    }]);
    expect(capture.finish()).toEqual(__audioCaptureTestUtils.encodeWAV([source], 16_000, 1));
  });

  it('observes a 48 kHz stereo source and downmixes one 20 ms frame to 16 kHz mono', () => {
    const capture = __audioCaptureTestUtils.createStreamingCapture({
      recordingSessionId: 'utterance-stereo',
      maxInFlightChunks: 1,
    });

    const chunks = capture.push([
      new Float32Array(960).fill(1),
      new Float32Array(960).fill(-1),
    ], 48_000);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.pcm.byteLength).toBe(640);
    expect(chunks[0]?.pcm.every((byte) => byte === 0)).toBe(true);
    expect(capture.finish().byteLength).toBe(684);
  });

  it('stops realtime emission at the credit bound without losing retained WAV audio', () => {
    const source = new Float32Array(640).fill(0.25);
    const capture = __audioCaptureTestUtils.createStreamingCapture({
      recordingSessionId: 'utterance-2',
      maxInFlightChunks: 1,
    });

    expect(capture.push([source], 16_000)).toHaveLength(1);
    expect(capture.realtimeEnabled).toBe(false);
    expect(capture.finish()).toEqual(__audioCaptureTestUtils.encodeWAV([source], 16_000, 1));
  });

  it('encodes PCM samples into a valid 16-bit WAV file', () => {
    const wav = __audioCaptureTestUtils.encodeWAV(
      [new Float32Array([-1, 0, 1])],
      16000,
      1
    );
    const view = new DataView(wav.buffer);

    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe('WAVE');
    expect(new TextDecoder().decode(wav.slice(36, 40))).toBe('data');
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(32767);
  });
});

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

describe('recording lifecycle', () => {
  it('opens the selected microphone and returns audio data after closing the capture stream', async () => {
    const stopTrack = vi.fn();
    const disconnect = vi.fn();
    const close = vi.fn();
    let audioProcess: ((event: AudioProcessingEvent) => void) | null = null;

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        send: vi.fn(),
      },
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: stopTrack }],
        })),
      },
    });
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: vi.fn(function AudioContext() {
        return {
          sampleRate: 16000,
          destination: {},
          createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect })),
          createScriptProcessor: vi.fn(() => ({
            connect: vi.fn(),
            disconnect,
            set onaudioprocess(handler: (event: AudioProcessingEvent) => void) {
              audioProcess = handler;
            },
          })),
          close,
        };
      }),
    });

    const onPcmChunk = vi.fn();
    const source = new Float32Array(640).fill(0.25);
    setSelectedDeviceId('mic-123');
    await startRecording({
      recordingSessionId: 'capture-session',
      maxInFlightChunks: 50,
      onPcmChunk,
      onRealtimeDisabled: vi.fn(),
    });
    expect(audioProcess).toBeTypeOf('function');
    (audioProcess as unknown as (event: AudioProcessingEvent) => void)({
      inputBuffer: {
        numberOfChannels: 1,
        getChannelData: () => source,
      },
    } as unknown as AudioProcessingEvent);
    const wav = stopRecording();

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        deviceId: { exact: 'mic-123' },
        sampleRate: 16000,
      }) as MediaTrackConstraints,
    });
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(onPcmChunk.mock.calls.map(([chunk]: [{ sequence: number; pcm: Uint8Array }]) => [
      chunk.sequence,
      chunk.pcm.byteLength,
    ])).toEqual([
      [0, 640],
      [1, 640],
    ]);
    expect(wav).toEqual(__audioCaptureTestUtils.encodeWAV([source], 16_000, 1));
  });
});

describe('capture cleanup', () => {
  it('stops microphone tracks when setup fails after acquisition', async () => {
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: stopTrack }],
        })),
      },
    });
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: vi.fn(() => {
        throw new Error('Audio context failed');
      }),
    });

    await expect(startRecording()).rejects.toThrow('Audio context failed');
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });
});

describe('warm audio stream', () => {
  let stopTrack: ReturnType<typeof vi.fn>;
  let disconnect: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let audioProcess: ((event: AudioProcessingEvent) => void) | null;
  let send: ReturnType<typeof vi.fn>;

  async function importWarm() {
    return import(`../audio-capture?warm=${Date.now()}-${Math.random()}`);
  }

  function installAudioMocks() {
    stopTrack = vi.fn();
    disconnect = vi.fn();
    close = vi.fn();
    audioProcess = null;
    send = vi.fn();
    getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: stopTrack }],
    }));

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { send },
    });
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
          sampleRate: 16000,
          destination: {},
          createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect })),
          createScriptProcessor: vi.fn(() => ({
            connect: vi.fn(),
            disconnect,
            set onaudioprocess(handler: (event: AudioProcessingEvent) => void) {
              audioProcess = handler;
            },
          })),
          close,
        };
      }),
    });
  }

  it('prepares microphone permission once and opens a fresh capture stream per recording', async () => {
    installAudioMocks();
    const mod = await importWarm();
    mod.setSelectedDeviceId('mic-123');

    await mod.prepareStream();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(audioProcess).toBeNull();
    expect(stopTrack).toHaveBeenCalledTimes(1);

    await mod.startRecording();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(audioProcess).toBeTypeOf('function');

    (audioProcess as unknown as (event: AudioProcessingEvent) => void)({
      inputBuffer: { getChannelData: () => new Float32Array([0.2, -0.4, 0.6]) },
    } as unknown as AudioProcessingEvent);

    const wav = mod.stopRecording();
    expect(wav.byteLength).toBe(50);
    expect(stopTrack).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);

    await mod.startRecording();
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    mod.stopRecording();
    expect(stopTrack).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('throttles recording pill level telemetry without dropping captured audio chunks or emitting duration updates', async () => {
    installAudioMocks();
    const intervalCallbacks: Array<() => void> = [];
    const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation((callback: () => void) => {
      intervalCallbacks.push(callback);
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const mod = await importWarm();

    try {
      await mod.startRecording();
      expect(audioProcess).toBeTypeOf('function');
      expect(intervalCallbacks).toHaveLength(1);

      const processAudio = () => {
        (audioProcess as unknown as (event: AudioProcessingEvent) => void)({
          inputBuffer: { getChannelData: () => new Float32Array([0.2, -0.4, 0.6]) },
        } as unknown as AudioProcessingEvent);
      };

      processAudio();
      processAudio();
      processAudio();
      processAudio();
      intervalCallbacks.forEach((callback) => callback());

      const wav = mod.stopRecording();
      const telemetryCalls = send.mock.calls.filter(([channel]: [string, ...unknown[]]) =>
        channel === 'audio-level-changed' || channel === 'audio-duration-changed'
      );

      expect(telemetryCalls).toEqual([
        ['audio-level-changed', 0],
        ['audio-level-changed', expect.closeTo(1)],
      ]);
      expect(wav.byteLength).toBe(68);
      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      intervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('re-prepares microphone permission with the new device on device change', async () => {
    installAudioMocks();
    const mod = await importWarm();
    mod.setSelectedDeviceId('mic-1');

    await mod.prepareStream();
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await mod.recreateStream('mic-2');

    expect(stopTrack).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: expect.objectContaining({
        deviceId: { exact: 'mic-2' },
        sampleRate: 16000,
      }) as MediaTrackConstraints,
    });
  });
});
