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
  it('opens the selected microphone, emits levels, and returns audio data when stopped without closing the warm stream', async () => {
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

    setSelectedDeviceId('mic-123');
    await startRecording();
    expect(audioProcess).toBeTypeOf('function');
    (audioProcess as unknown as (event: AudioProcessingEvent) => void)({
      inputBuffer: {
        getChannelData: () => new Float32Array([0.2, -0.4, 0.6]),
      },
    } as unknown as AudioProcessingEvent);
    const wav = stopRecording();

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        deviceId: { exact: 'mic-123' },
        sampleRate: 16000,
      }) as MediaTrackConstraints,
    });
    const sendCalls = (window.electronAPI?.send as ReturnType<typeof mock>).mock.calls;
    const levelCall = sendCalls.find(([channel]: [string, ...unknown[]]) => channel === 'audio-level-changed');
    expect(levelCall?.[1]).toBeCloseTo(1);
    expect(stopTrack).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(wav.byteLength).toBe(50);
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

  it('prepares the microphone once and reuses the warm stream across recordings without re-opening it', async () => {
    installAudioMocks();
    const mod = await importWarm();
    mod.setSelectedDeviceId('mic-123');

    await mod.prepareStream();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(audioProcess).toBeTypeOf('function');

    await mod.startRecording();
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    (audioProcess as unknown as (event: AudioProcessingEvent) => void)({
      inputBuffer: { getChannelData: () => new Float32Array([0.2, -0.4, 0.6]) },
    } as unknown as AudioProcessingEvent);

    const wav = mod.stopRecording();
    expect(wav.byteLength).toBe(50);

    await mod.startRecording();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    mod.stopRecording();
    expect(stopTrack).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('recreates the stream with the new device on device change, tearing down the previous stream', async () => {
    installAudioMocks();
    const mod = await importWarm();
    mod.setSelectedDeviceId('mic-1');

    await mod.prepareStream();
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await mod.recreateStream('mic-2');

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: expect.objectContaining({
        deviceId: { exact: 'mic-2' },
        sampleRate: 16000,
      }) as MediaTrackConstraints,
    });
  });
});
