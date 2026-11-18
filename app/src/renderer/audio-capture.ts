import { bandsFromSpectrum, publishAudioLevel, setBandReader } from './audio-level';
import { hasChosenMicrophone } from '../shared/microphone-selection';
// Web Audio API audio capture for Electron renderer process
// Runs in a hidden BrowserWindow. Samples come from an AudioWorklet
// (audio-capture-worklet.js) and are converted once, at the actual context
// rate, to the canonical 16 kHz mono PCM16. Every converted batch goes straight
// to main's per-recording spool; the renderer retains no recording. Each batch
// holds a worklet credit until main confirms the write, so a stalled renderer
// or main fails the capture instead of queueing audio without bound. Stop waits
// for the worklet's ack and every write confirmation, then returns the end
// boundary main verifies. With the warm microphone opted in, a cleanly stopped
// recording parks its mic instead of closing it; the idle worklet keeps only a
// PRE_ROLL_MS ring, which the next recording adopts as its head.
import { PRE_ROLL_MS, type AudioDevice } from '../types/ipc';

const AUDIO_LEVEL_TELEMETRY_INTERVAL_MS = 50;
const STREAM_SAMPLE_RATE = 16_000;
/** About 31 Hz per bin at 16 kHz: fine enough for the pill's lowest voice band. */
const ANALYSER_FFT_SIZE = 512;
const STREAM_CHUNK_BYTES = 640;
const WORKLET_URL = new URL('./audio-capture-worklet.js?no-inline', import.meta.url).href;
const WORKLET_PROCESSOR = 'shuddhalekhan-capture';
// Fail closed if the audio thread cannot confirm its final sample boundary.
const STOP_ACK_TIMEOUT_MS = 500;
// Fail closed if main cannot confirm the tail of the spool.
const SPOOL_ACK_TIMEOUT_MS = 2_000;
// Fail closed if mic permission/open or worklet load never settles; generous for a permission prompt.
const SETUP_TIMEOUT_MS = 30_000;
// A cue holds pre-roll back until it has sounded, at most this long should its context never run.
const CUE_MAX_HOLD_MS = 3_000;
// ponytail: fixed allowance for output latency after a cue's last sample renders
// (Bluetooth runs ~150–250 ms); measure the device if a cue still leaks into pre-roll.
const CUE_OUTPUT_LATENCY_MS = 350;
// A Dictation release often lands while the last word still sounds, so stop
// keeps this much audio (Hex's base tail), growing while speech continues
// until this much quiet or main's cap.
const RELEASE_TAIL_MS = 200;
const RELEASE_TAIL_QUIET_MS = 160;
// ponytail: level heuristic, not VAD. A batch is speech if its mean level is
// within 20 dB of the loudest batch before release, and above the noise floor.
const SPEECH_FLOOR = 0.003;
const SPEECH_RELATIVE = 0.1;
/** One second of buffered audio at 16 kHz with 320-sample chunks. */
export const MAX_IN_FLIGHT_PCM_CHUNKS = 50;

export interface StreamingPcmChunk {
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
  /** Head the recording with the warm mic's pre-roll (Dictation only). */
  preRoll?: boolean;
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
    options.onPcmChunk({ sequence: sequence++, pcm });
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

/** An open microphone: stream, context and worklet. Owned by one recording, or parked as the warm mic. */
interface Mic {
  readonly stream: Promise<MediaStream>;
  ready: Promise<void>;
  readonly context: AudioContext;
  source: MediaStreamAudioSourceNode | null;
  node: AudioWorkletNode | null;
  /** Read by the recording pill for its frequency bands; never touches the recorded audio. */
  analyser: AnalyserNode | null;
  owner: Capture | null;
  stopWatching: (() => void) | null;
  closed: boolean;
  /** A device change landed while it recorded: close it after, never park it. */
  stale: boolean;
}

/** One recording on its mic, until released. */
interface Capture {
  readonly mic: Mic;
  ready: Promise<void>;
  readonly convert: (input: Float32Array) => Uint8Array<ArrayBuffer>;
  readonly realtime: ReturnType<typeof createRealtimeChunker> | null;
  readonly options: RecordingOptions;
  chunkCount: number;
  sampleCount: number;
  /** Spool writes main has not confirmed yet; each holds one worklet credit. */
  readonly writes: Set<Promise<void>>;
  failure: Error | null;
  released: boolean;
  /**
   * Wakes the step start or stop is waiting on: the worklet's start or stop ack,
   * the release tail, all writes settled, or release.
   */
  onStopped: (() => void) | null;
  /** Loudest batch level before release; the release tail's speech reference. */
  peakLevel: number;
  /** Set while stop keeps a release tail; told whether each batch sounds like speech. */
  onTailBatch: ((speech: boolean) => void) | null;
}

type WorkletMessage =
  | { type: 'audio' | 'started'; samples: Float32Array }
  | { type: 'stopped' }
  | { type: 'overflow' };

/** The recording that start/cancel act on. A stopping capture is detached but stays in `live` until drained. */
let active: Capture | null = null;
const live = new Set<Capture>();
/** Opened or parked between recordings while the warm microphone is wanted; owned by no recording. */
let warm: Mic | null = null;
let warmWanted = false;
/** performance.now() before which the ring may hold a speaker cue. */
let cueHeldUntil = 0;
let isStreamPrepared = false;
let latestAudioLevel = 0;
let levelTelemetryTimer: ReturnType<typeof setInterval> | null = null;
let selectedDeviceId: string | null = null;
let hasAudioPermission = false;

export function setSelectedDeviceId(deviceId: string | null): void {
  selectedDeviceId = deviceId;
}

function getDeviceId(): string | undefined {
  if (!hasChosenMicrophone(selectedDeviceId)) {
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
  // Device IDs are per-origin hashes that go stale (dev server vs file://, unplugged or
  // renamed mics). An advanced `exact` set always picks the device when present and is
  // dropped when it is not, so a stale ID records from another mic instead of failing.
  if (deviceId) audio.advanced = [{ deviceId: { exact: deviceId } }];
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

let spectrum: Float32Array<ArrayBuffer> | null = null;

/** The active capture's bands, read by the pill once per drawn frame. */
function readActiveBands(out: Float32Array): boolean {
  const analyser = active?.mic.analyser;
  if (!analyser) return false;
  if (spectrum?.length !== analyser.frequencyBinCount) spectrum = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(spectrum);
  bandsFromSpectrum(spectrum, analyser.context.sampleRate / analyser.fftSize, out);
  return true;
}

function stopLevelTelemetry(): void {
  if (levelTelemetryTimer) {
    clearInterval(levelTelemetryTimer);
    levelTelemetryTimer = null;
  }
  latestAudioLevel = 0;
  setBandReader(null);
}

function startLevelTelemetry(): void {
  stopLevelTelemetry();
  setBandReader(readActiveBands);
  publishAudioLevel(latestAudioLevel);
  levelTelemetryTimer = setInterval(() => {
    publishAudioLevel(latestAudioLevel);
  }, AUDIO_LEVEL_TELEMETRY_INTERVAL_MS);
}

/** Idempotent: stops the mic's tracks, nodes and context, which drops its ring. */
function closeMic(mic: Mic): void {
  if (mic.closed) return;
  mic.closed = true;
  if (warm === mic) warm = null;
  mic.stopWatching?.();
  mic.stopWatching = null;
  if (mic.node) {
    mic.node.onprocessorerror = null;
    mic.node.port.onmessage = null;
    mic.node.port.close();
    mic.node.disconnect();
  }
  mic.source?.disconnect();
  void mic.stream.then((stream) => stream.getTracks().forEach((track) => track.stop()), () => undefined);
  void Promise.resolve(mic.context.close()).catch(() => undefined);
}

/** Opens the warm mic when it is wanted and no recording holds a mic; never retries a mic that failed. */
function ensureWarm(): void {
  if (!warmWanted || warm || live.size > 0) return;
  let mic: Mic;
  try {
    mic = openMic();
  } catch (error) {
    console.error('Failed to open the warm microphone:', error);
    return;
  }
  warm = mic;
  mic.ready.catch((error: unknown) => {
    if (mic.owner) return;
    console.error('Failed to open the warm microphone:', error);
    closeMic(mic);
  });
}

/**
 * Idempotent: ends this capture and drops its callbacks. `park` (a clean stop)
 * keeps the mic as the warm mic when that is wanted; otherwise the mic closes.
 */
function release(capture: Capture, park = false): void {
  if (capture.released) return;
  capture.released = true;
  live.delete(capture);
  if (active === capture) {
    active = null;
    stopLevelTelemetry();
  }
  capture.onStopped?.();
  const { mic } = capture;
  mic.owner = null;
  if (park && warmWanted && !warm && !mic.stale && !mic.closed) warm = mic;
  else closeMic(mic);
  // A failed mic is not reopened at once: the next recording opens cold and may park.
  if (!capture.failure) ensureWarm();
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
    capture.mic.node?.port.postMessage({ type: 'credit' });
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
  const pcm = capture.convert(samples);
  if (pcm.byteLength > 0) {
    capture.realtime?.push(pcm);
    capture.sampleCount += pcm.byteLength / 2;
    spool(capture, pcm);
  } else if (samples.length > 0) {
    // Nothing to write; return the credit at once. An empty pre-roll spent none.
    capture.mic.node?.port.postMessage({ type: 'credit' });
  }

  let sum = 0;
  for (const sample of samples) sum += Math.abs(sample);
  const level = samples.length > 0 ? sum / samples.length : 0;
  if (capture.onTailBatch) {
    capture.onTailBatch(level > Math.max(SPEECH_FLOOR, capture.peakLevel * SPEECH_RELATIVE));
  } else if (message.type === 'audio') {
    // Pre-roll may hold a cue or media from before the press; it never sets the speech reference.
    capture.peakLevel = Math.max(capture.peakLevel, level);
  }
  if (capture === active) latestAudioLevel = Math.min(level * 10, 1);
  if (message.type === 'started') capture.onStopped?.();
}

/** A fault on the mic fails the recording that owns it, or closes it while it is parked. */
function micFailed(mic: Mic, error: Error): void {
  if (mic.owner) fail(mic.owner, error);
  else closeMic(mic);
}

/** The ring the worklet keeps while idle. */
function preRollFrames(context: BaseAudioContext): number {
  return Math.round(context.sampleRate * PRE_ROLL_MS / 1000);
}

/** Opens the selected mic. Its worklet stays idle, keeping only the pre-roll ring, until a recording starts it. */
function openMic(): Mic {
  // Built first, so a context that cannot be built never opens the mic. The
  // worklet then loads while the mic permission/open is pending.
  const context = new AudioContext({ sampleRate: STREAM_SAMPLE_RATE });
  const mic: Mic = {
    stream: navigator.mediaDevices.getUserMedia(buildConstraints()),
    ready: Promise.resolve(),
    context,
    source: null,
    node: null,
    analyser: null,
    owner: null,
    stopWatching: null,
    closed: false,
    stale: false,
  };
  mic.ready = setupMic(mic);
  return mic;
}

async function setupMic(mic: Mic): Promise<void> {
  const { context } = mic;
  const watchedMic = mic.stream.then(stream => {
    if (mic.closed) return stream;
    const tracks = stream.getAudioTracks();
    const disconnected = () => {
      isStreamPrepared = false;
      micFailed(mic, new Error('The microphone disconnected or access was revoked. Check the input device and try again.'));
    };
    mic.stopWatching = () => tracks.forEach(track => track.removeEventListener('ended', disconnected));
    tracks.forEach(track => track.addEventListener('ended', disconnected));
    if (!tracks.length || tracks.some(track => track.readyState === 'ended')) disconnected();
    return stream;
  });
  const [stream] = await Promise.all([watchedMic, context.audioWorklet.addModule(WORKLET_URL)]);
  if (mic.closed) return;
  hasAudioPermission = true;
  isStreamPrepared = true;

  mic.source = context.createMediaStreamSource(stream);
  // Zero outputs: the worklet is a sink, nothing is played back. The explicit
  // mono input is the single downmix boundary.
  const node = new AudioWorkletNode(context, WORKLET_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: { preRollFrames: preRollFrames(context) },
  });
  mic.node = node;
  node.onprocessorerror = () => micFailed(mic, new Error('The microphone audio processor failed.'));
  node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
    if (mic.owner) handleWorkletMessage(mic.owner, event.data);
  };
  mic.source.connect(node);
  const analyser = context.createAnalyser();
  analyser.fftSize = ANALYSER_FFT_SIZE;
  // The pill smooths by elapsed time, so the analyser must not smooth per read.
  analyser.smoothingTimeConstant = 0;
  mic.source.connect(analyser);
  mic.analyser = analyser;
  if (context.state === 'suspended') await context.resume();
}

/**
 * Waits for the mic, then starts its worklet, which hands over `preRoll`
 * ring frames first. A setup that outlives the deadline finds the capture
 * released; closing the mic still stops the tracks if it opens late.
 */
async function admit(capture: Capture, preRoll: number): Promise<void> {
  const { mic } = capture;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([mic.ready, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Microphone did not start in time.')), SETUP_TIMEOUT_MS);
  })]).finally(() => clearTimeout(timer));
  const { node } = mic;
  if (capture.released || !node) return;
  if (capture === active) startLevelTelemetry();
  await waitForCapture(capture, STOP_ACK_TIMEOUT_MS, 'Microphone did not start in time.',
    () => node.port.postMessage({ type: 'start', preRollFrames: preRoll }));
}

/**
 * Starts one recording on the warm mic, or opens the selected mic. The device
 * is fixed at start; later device switches only affect the next recording.
 * Resolves with the 16 kHz samples recorded before the press (warm pre-roll,
 * minus any speaker cue), which head the spool. Resolves without starting if
 * cancelRecording() lands while permission or worklet setup is pending.
 */
export async function startRecording(options: RecordingOptions): Promise<number> {
  if (active) return 0;

  const adopted = warm;
  warm = null;
  const mic = adopted ?? openMic();
  const capture: Capture = {
    mic,
    ready: Promise.resolve(),
    convert: createPcm16Converter(mic.context.sampleRate),
    realtime: options.streaming ? createRealtimeChunker(options.streaming) : null,
    options,
    chunkCount: 0,
    sampleCount: 0,
    writes: new Set(),
    failure: null,
    released: false,
    onStopped: null,
    peakLevel: 0,
    onTailBatch: null,
  };
  mic.owner = capture;
  active = capture;
  live.add(capture);
  // A cold mic's ring holds only audio from after the press: all of it is recording, none is pre-roll.
  const cueFree = options.preRoll ? Math.max(0, performance.now() - cueHeldUntil) : 0;
  const preRoll = adopted ? Math.round(mic.context.sampleRate * Math.min(PRE_ROLL_MS, cueFree) / 1000) : preRollFrames(mic.context);
  capture.ready = admit(capture, preRoll);

  try {
    await capture.ready;
  } catch (error) {
    if (capture.released) return 0;
    capture.failure = error instanceof Error ? error : new Error(String(error));
    release(capture);
    throw error;
  }
  return adopted && !capture.released ? capture.sampleCount : 0;
}

/**
 * A speaker cue starts now: keep it out of the next recording's pre-roll.
 * Call the returned function once every cue has stopped sounding.
 */
export function holdPreRollForCue(): () => void {
  cueHeldUntil = performance.now() + CUE_MAX_HOLD_MS;
  return () => {
    cueHeldUntil = performance.now() + CUE_OUTPUT_LATENCY_MS;
  };
}

/**
 * Opts the warm microphone in or out. Out closes the parked mic and its ring at
 * once; a recording in progress keeps its mic and closes it when it ends.
 */
export function setWarmMicrophone(enabled: boolean): void {
  warmWanted = enabled;
  if (enabled) ensureWarm();
  else if (warm) closeMic(warm);
}

/** A recording in progress finishes on its mic and closes after; a parked mic closes now. */
function retireMic(mic: Mic): void {
  if (mic.owner) mic.stale = true;
  else closeMic(mic);
}

/** The selected device changed: retire every mic and reopen the warm mic on the new device. */
function retireMics(): void {
  for (const capture of live) retireMic(capture.mic);
  if (warm) retireMic(warm);
  ensureWarm();
}

/**
 * The device list changed: retire only mics no longer on the device the next
 * recording would open. A headset switching profiles, or another device
 * plugged in, keeps the mic, so reopening it cannot loop.
 */
async function deviceListChanged(): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const inputs = devices.filter((device) => device.kind === 'audioinput');
  const chosen = getDeviceId();
  const target = inputs.find((device) => device.deviceId === chosen)
    ?? inputs.find((device) => device.deviceId === 'default');
  const mics = [...live].map((capture) => capture.mic);
  if (warm) mics.push(warm);
  for (const mic of mics) {
    const stream = await mic.stream.catch(() => null);
    const groupId = stream?.getAudioTracks()[0]?.getSettings().groupId;
    if (target && groupId === target.groupId) continue;
    retireMic(mic);
  }
  ensureWarm();
}

navigator.mediaDevices?.addEventListener?.('devicechange', () => void deviceListChanged());

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
 * Keeps recording for the release tail: at least RELEASE_TAIL_MS, then until
 * RELEASE_TAIL_QUIET_MS without speech, never past `maxMs`. Tail length counts
 * audio received, not arrival time, so late back-to-back batches cannot end it
 * early; the wall-clock timer is only the hard cap. Release (cancel or failure) ends
 * the wait at once.
 */
function keepReleaseTail(capture: Capture, maxMs: number): Promise<void> {
  const base = Math.min(RELEASE_TAIL_MS, maxMs);
  const startSamples = capture.sampleCount;
  let lastSpeech = 0;
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      capture.onTailBatch = null;
      capture.onStopped = null;
      resolve();
    };
    const timer = setTimeout(done, maxMs);
    capture.onStopped = done;
    capture.onTailBatch = (speech) => {
      const ms = (capture.sampleCount - startSamples) * 1000 / STREAM_SAMPLE_RATE;
      if (speech) lastSpeech = ms;
      if (ms >= base && ms - lastSpeech >= RELEASE_TAIL_QUIET_MS) done();
    };
  });
}

/**
 * Stops the current recording after the worklet acknowledges and main has
 * confirmed every spool write, so every sample processed before the worklet
 * handles stop is on disk and the final realtime frame sent. A future
 * `tailEndsAt` (Date.now() ms) first keeps a release tail (see keepReleaseTail)
 * in the same spool, never past that time. This does not drain samples still
 * buffered by the microphone/browser. Waits for a pending start. Rejects if
 * startup, the processor, or a spool write failed or timed out; resolves null
 * if the capture was cancelled meanwhile.
 */
export async function stopRecording(tailEndsAt = 0): Promise<CaptureBoundary | null> {
  const capture = active;
  if (!capture) return { chunkCount: 0, sampleCount: 0 };
  active = null;
  stopLevelTelemetry();
  let clean = false;

  try {
    await capture.ready;
    if (capture.failure) throw capture.failure;
    const { node } = capture.mic;
    const maxTailMs = tailEndsAt - Date.now();
    if (maxTailMs > 0 && node && !capture.released) await keepReleaseTail(capture, maxTailMs);
    if (capture.failure) throw capture.failure;
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
    // The worklet acknowledged stop, so it is idle again with an empty ring: the mic may park.
    clean = true;
    return { chunkCount: capture.chunkCount, sampleCount: capture.sampleCount };
  } catch (error) {
    // A stop that timed out is an audio failure: its mic is not reopened at once.
    capture.failure ??= error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    capture.onStopped = null;
    release(capture, clean);
  }
}

/**
 * Drops running, starting, and draining audio without emitting a completed
 * recording. Their mics close, so a dropped utterance never becomes pre-roll.
 */
export function cancelRecording(): void {
  for (const capture of live) {
    // Main cancels a mic that never opened in time: treat it as failed, so it is not reopened at once.
    if (!capture.mic.node) capture.failure ??= new Error('Cancelled before the microphone opened.');
    release(capture);
  }
}

/** Device changes re-prepare permission and reopen the warm mic; a running recording keeps its mic. */
export async function recreateStream(deviceId: string | null): Promise<void> {
  setSelectedDeviceId(deviceId);
  retireMics();
  isStreamPrepared = false;
  await prepareStream();
}

export function acknowledgeRealtimeChunk(recordingSessionId: string, sequence: number): void {
  for (const capture of live) {
    if (capture.options.streaming?.recordingSessionId === recordingSessionId) capture.realtime?.acknowledge(sequence);
  }
}
