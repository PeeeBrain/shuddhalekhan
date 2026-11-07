// Web Audio API audio capture for Electron renderer process
// Runs in a hidden BrowserWindow. Samples come from an AudioWorklet
// (audio-capture-worklet.js) and are converted once, at the actual context
// rate, to the canonical 16 kHz mono PCM16. Every converted batch goes straight
// to main's per-recording spool; the renderer retains no recording. Each batch
// holds a worklet credit until main confirms the write, so a stalled renderer
// or main fails the capture instead of queueing audio without bound. Stop waits
// for the worklet's ack and every write confirmation, then returns the end
// boundary main verifies.
import type { AudioDevice } from '../types/ipc';

const AUDIO_LEVEL_TELEMETRY_INTERVAL_MS = 50;
const STREAM_SAMPLE_RATE = 16_000;
const STREAM_CHUNK_BYTES = 640;
const WORKLET_URL = new URL('./audio-capture-worklet.js?no-inline', import.meta.url).href;
const WORKLET_PROCESSOR = 'shuddhalekhan-capture';
// Fail closed if the audio thread cannot confirm its final sample boundary.
const STOP_ACK_TIMEOUT_MS = 500;
// Fail closed if main cannot confirm the tail of the spool.
const SPOOL_ACK_TIMEOUT_MS = 2_000;
// Fail closed if mic permission/open or worklet load never settles; generous for a permission prompt.
const SETUP_TIMEOUT_MS = 30_000;
/** One second of buffered audio at 16 kHz with 320-sample chunks. */
export const MAX_IN_FLIGHT_PCM_CHUNKS = 50;

export interface StreamingPcmChunk {
  recordingSessionId: string;
  sequence: number;
  pcm: Uint8Array<ArrayBuffer>;
}

export interface StreamingRecordingOptions {
  recordingSessionId: string;
  maxInFlightChunks: number;
  onPcmChunk: (chunk: StreamingPcmChunk) => void;
  onRealtimeDisabled: () => void;
}

export interface RecordingOptions {
  /**
   * Every converted batch, in order from 0; main spools these as the canonical
   * recording. Resolves once main has written the batch, rejects if it did not.
   */
  onSpoolChunk: (chunkSequence: number, pcm: Uint8Array<ArrayBuffer>) => Promise<void>;
  streaming?: StreamingRecordingOptions;
  onFailure?: (error: Error) => void;
}

/** What stop declares was spooled; main rejects the recording unless it matches. */
export interface CaptureBoundary {
  chunkCount: number;
  sampleCount: number;
}

/** Decimating resampler + PCM16 encoder from the context rate to 16 kHz. */
function createPcm16Converter(sourceRate: number): (input: Float32Array) => Uint8Array<ArrayBuffer> {
  let accumulator = 0;
  return (input) => {
    const out = new Uint8Array(Math.floor((accumulator + input.length * STREAM_SAMPLE_RATE) / sourceRate) * 2);
    const view = new DataView(out.buffer);
    let offset = 0;
    for (const sample of input) {
      accumulator += STREAM_SAMPLE_RATE;
      if (accumulator < sourceRate) continue;
      const clamped = Math.max(-1, Math.min(1, sample));
      const pcm16 = Math.trunc(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
      while (accumulator >= sourceRate) {
        view.setInt16(offset, pcm16, true);
        offset += 2;
        accumulator -= sourceRate;
      }
    }
    return out;
  };
}

/** Re-chunks spool batches into 20 ms realtime frames under an in-flight credit bound. */
function createRealtimeChunker(options: StreamingRecordingOptions) {
  let enabled = true;
  let sequence = 0;
  let filled = 0;
  const pending = new Uint8Array(STREAM_CHUNK_BYTES);
  const inFlight = new Set<number>();
  const emit = (pcm: Uint8Array<ArrayBuffer>) => {
    inFlight.add(sequence);
    options.onPcmChunk({ recordingSessionId: options.recordingSessionId, sequence: sequence++, pcm });
  };
  return {
    push(bytes: Uint8Array): void {
      let offset = 0;
      while (enabled && offset < bytes.length) {
        const count = Math.min(bytes.length - offset, STREAM_CHUNK_BYTES - filled);
        pending.set(bytes.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled < STREAM_CHUNK_BYTES) return;
        filled = 0;
        // Recognition fell behind: stop previews; the spool still holds every sample.
        if (inFlight.size >= options.maxInFlightChunks) {
          enabled = false;
          options.onRealtimeDisabled();
          return;
        }
        emit(pending.slice());
      }
    },
    acknowledge(acknowledged: number): void {
      inFlight.delete(acknowledged);
    },
    /** Sends the final partial frame so realtime recognition sees the whole tail. */
    finish(): void {
      if (enabled && filled > 0) emit(pending.slice(0, filled));
      filled = 0;
      inFlight.clear();
    },
  };
}

/** One recording: owns its mic stream, context and worklet until released. */
interface Capture {
  readonly mic: Promise<MediaStream>;
  ready: Promise<void>;
  context: AudioContext | null;
  source: MediaStreamAudioSourceNode | null;
  node: AudioWorkletNode | null;
  convert: ((input: Float32Array) => Uint8Array<ArrayBuffer>) | null;
  readonly realtime: ReturnType<typeof createRealtimeChunker> | null;
  readonly options: RecordingOptions;
  chunkCount: number;
  sampleCount: number;
  /** Spool writes main has not confirmed yet; each holds one worklet credit. */
  readonly writes: Set<Promise<void>>;
  failure: Error | null;
  stopWatchingMic: (() => void) | null;
  released: boolean;
  /** Wakes the step stop is waiting on: the worklet's ack, all writes settled, or release. */
  onStopped: (() => void) | null;
}

type WorkletMessage = { type: 'audio'; samples: Float32Array } | { type: 'stopped' } | { type: 'overflow' };

/** The recording that start/cancel act on. A stopping capture is detached but stays in `live` until drained. */
let active: Capture | null = null;
const live = new Set<Capture>();
let isStreamPrepared = false;
let latestAudioLevel = 0;
let levelTelemetryTimer: ReturnType<typeof setInterval> | null = null;
let selectedDeviceId: string | null = null;
let hasAudioPermission = false;

export function setSelectedDeviceId(deviceId: string | null): void {
  selectedDeviceId = deviceId;
}

function getDeviceId(): string | undefined {
  if (!selectedDeviceId || selectedDeviceId === 'default') {
    return undefined;
  }

  return selectedDeviceId;
}

export async function enumerateDevices(): Promise<AudioDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    console.error('Media device enumeration is not available');
    return [];
  }

  if (!hasAudioPermission && !isStreamPrepared) {
    let stream: MediaStream | null = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      hasAudioPermission = true;
    } catch (err) {
      console.error('Failed to request microphone permission before device enumeration:', err);
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const audioDevices: AudioDevice[] = [];
  for (const device of devices) {
    if (device.kind !== 'audioinput') continue;
    audioDevices.push({
      deviceId: device.deviceId,
      label: device.label,
      kind: 'audioinput',
    });
  }
  return audioDevices;
}

function buildConstraints(): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    sampleRate: 16000,
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  const deviceId = getDeviceId();
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio };
}

export async function prepareStream(): Promise<void> {
  if (isStreamPrepared) return;

  let permissionStream: MediaStream | null = null;
  try {
    permissionStream = await navigator.mediaDevices.getUserMedia(buildConstraints());
    hasAudioPermission = true;
  } catch (err) {
    console.error('Failed to prepare microphone:', err);
    throw err;
  } finally {
    permissionStream?.getTracks().forEach((track) => track.stop());
  }

  isStreamPrepared = true;
}

function stopLevelTelemetry(): void {
  if (levelTelemetryTimer) {
    clearInterval(levelTelemetryTimer);
    levelTelemetryTimer = null;
  }
  latestAudioLevel = 0;
}

function startLevelTelemetry(): void {
  stopLevelTelemetry();
  window.electronAPI?.send('audio-level-changed', latestAudioLevel);
  levelTelemetryTimer = setInterval(() => {
    window.electronAPI?.send('audio-level-changed', latestAudioLevel);
  }, AUDIO_LEVEL_TELEMETRY_INTERVAL_MS);
}

/** Idempotent: stops this capture's tracks, nodes and context and drops its callbacks. */
function release(capture: Capture): void {
  if (capture.released) return;
  capture.released = true;
  capture.stopWatchingMic?.();
  capture.stopWatchingMic = null;
  live.delete(capture);
  if (active === capture) {
    active = null;
    stopLevelTelemetry();
  }
  capture.onStopped?.();
  if (capture.node) {
    capture.node.onprocessorerror = null;
    capture.node.port.onmessage = null;
    capture.node.port.close();
    capture.node.disconnect();
  }
  capture.source?.disconnect();
  void capture.mic.then((stream) => stream.getTracks().forEach((track) => track.stop()), () => undefined);
  void Promise.resolve(capture.context?.close()).catch(() => undefined);
}

/** Ends the capture without a recording: releases the mic and reports once. */
function fail(capture: Capture, error: Error): void {
  if (capture.released) return;
  capture.failure = error;
  release(capture);
  capture.options.onFailure?.(error);
}

/** Hands one batch to main; its worklet credit returns only after main confirms the write. */
function spool(capture: Capture, pcm: Uint8Array<ArrayBuffer>): void {
  let write: Promise<void>;
  try {
    write = capture.options.onSpoolChunk(capture.chunkCount++, pcm);
  } catch (error) {
    write = Promise.reject(error);
  }
  capture.writes.add(write);
  write.then(() => {
    capture.writes.delete(write);
    if (capture.released) return;
    capture.node?.port.postMessage({ type: 'credit' });
  }, (error: unknown) => {
    fail(capture, error instanceof Error ? error : new Error('Main did not accept spooled audio.'));
  });
}

function handleWorkletMessage(capture: Capture, message: WorkletMessage): void {
  if (capture.released) return;
  if (message.type === 'stopped') {
    capture.onStopped?.();
    return;
  }
  if (message.type === 'overflow') {
    fail(capture, new Error('Audio capture fell behind: main did not confirm spooled audio in time.'));
    return;
  }

  const { samples } = message;
  const pcm = capture.convert?.(samples);
  if (pcm && pcm.byteLength > 0) {
    capture.realtime?.push(pcm);
    capture.sampleCount += pcm.byteLength / 2;
    spool(capture, pcm);
  } else {
    capture.node?.port.postMessage({ type: 'credit' });
  }

  if (capture === active) {
    let sum = 0;
    for (const sample of samples) sum += Math.abs(sample);
    latestAudioLevel = samples.length > 0 ? Math.min((sum / samples.length) * 10, 1) : 0;
  }
}

async function setupCapture(capture: Capture): Promise<void> {
  // Build the context and load the worklet while the mic permission/open is pending.
  const context = new AudioContext({ sampleRate: STREAM_SAMPLE_RATE });
  capture.context = context;
  capture.convert = createPcm16Converter(context.sampleRate);
  const watchedMic = capture.mic.then(stream => {
    if (capture.released) return stream;
    const tracks = stream.getAudioTracks();
    const disconnected = () => {
      isStreamPrepared = false;
      fail(capture, new Error('The microphone disconnected or access was revoked. Check the input device and try again.'));
    };
    capture.stopWatchingMic = () => tracks.forEach(track => track.removeEventListener('ended', disconnected));
    tracks.forEach(track => track.addEventListener('ended', disconnected));
    if (!tracks.length || tracks.some(track => track.readyState === 'ended')) disconnected();
    return stream;
  });
  const [stream] = await Promise.all([watchedMic, context.audioWorklet.addModule(WORKLET_URL)]);
  if (capture.released) return;
  hasAudioPermission = true;
  isStreamPrepared = true;

  capture.source = context.createMediaStreamSource(stream);
  // Zero outputs: the worklet is a sink, nothing is played back. The explicit
  // mono input is the single downmix boundary.
  const node = new AudioWorkletNode(context, WORKLET_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: 'explicit',
  });
  capture.node = node;
  node.onprocessorerror = () => fail(capture, new Error('The microphone audio processor failed.'));
  node.port.onmessage = (event: MessageEvent<WorkletMessage>) => handleWorkletMessage(capture, event.data);
  capture.source.connect(node);
  if (context.state === 'suspended') await context.resume();
  if (capture.released) return;
  if (capture === active) startLevelTelemetry();
}

/**
 * Opens the selected mic for one recording. The device is fixed at start;
 * later device switches only affect the next recording. Resolves without
 * starting if cancelRecording() lands while permission or worklet setup is pending.
 */
export async function startRecording(options: RecordingOptions): Promise<void> {
  if (active) return;

  const capture: Capture = {
    mic: navigator.mediaDevices.getUserMedia(buildConstraints()),
    ready: Promise.resolve(),
    context: null,
    source: null,
    node: null,
    convert: null,
    realtime: options.streaming ? createRealtimeChunker(options.streaming) : null,
    options,
    chunkCount: 0,
    sampleCount: 0,
    writes: new Set(),
    failure: null,
    stopWatchingMic: null,
    released: false,
    onStopped: null,
  };
  active = capture;
  live.add(capture);
  // A setup that outlives the deadline finds the capture released; release()
  // still stops the tracks if the mic opens late.
  const setup = setupCapture(capture);
  setup.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  capture.ready = Promise.race([setup, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Microphone did not start in time.')), SETUP_TIMEOUT_MS);
  })]).finally(() => clearTimeout(timer));

  try {
    await capture.ready;
  } catch (error) {
    const cancelled = capture.released;
    release(capture);
    if (!cancelled) throw error;
  }
}

/** Resolves when `onStopped` fires (see Capture), rejects after the deadline. */
function waitForCapture(capture: Capture, timeoutMs: number, message: string, begin: () => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    capture.onStopped = () => {
      clearTimeout(timer);
      resolve();
    };
    begin();
  });
}

/**
 * Stops the current recording after the worklet acknowledges and main has
 * confirmed every spool write, so every sample processed before the worklet
 * handles stop is on disk and the final realtime frame sent. This does not
 * drain samples still buffered by the microphone/browser. Waits for a pending
 * start. Rejects if startup, the processor, or a spool write failed or timed
 * out; resolves null if the capture was cancelled meanwhile.
 */
export async function stopRecording(): Promise<CaptureBoundary | null> {
  const capture = active;
  if (!capture) return { chunkCount: 0, sampleCount: 0 };
  active = null;
  stopLevelTelemetry();

  try {
    await capture.ready;
    if (capture.failure) throw capture.failure;
    const { node } = capture;
    if (node && !capture.released) {
      await waitForCapture(capture, STOP_ACK_TIMEOUT_MS, 'Audio capture did not acknowledge stopping.',
        () => node.port.postMessage({ type: 'stop' }));
    }
    if (capture.failure) throw capture.failure;
    if (capture.released) return null;
    // The worklet has stopped, so no new writes start. A rejected write fails (and releases) the capture.
    await waitForCapture(capture, SPOOL_ACK_TIMEOUT_MS, 'Main did not confirm spooled audio before stop.',
      () => void Promise.allSettled([...capture.writes]).then(() => capture.onStopped?.()));
    if (capture.failure) throw capture.failure;
    if (capture.released) return null;
    capture.realtime?.finish();
    return { chunkCount: capture.chunkCount, sampleCount: capture.sampleCount };
  } finally {
    capture.onStopped = null;
    release(capture);
  }
}

/** Drops running, starting, and draining audio without emitting a completed recording. */
export function cancelRecording(): void {
  for (const capture of live) release(capture);
}

/** Device changes re-prepare permission only; a running recording keeps its mic. */
export async function recreateStream(deviceId: string | null): Promise<void> {
  setSelectedDeviceId(deviceId);
  isStreamPrepared = false;
  await prepareStream();
}

export function acknowledgeRealtimeChunk(recordingSessionId: string, sequence: number): void {
  for (const capture of live) {
    if (capture.options.streaming?.recordingSessionId === recordingSessionId) capture.realtime?.acknowledge(sequence);
  }
}
