// Web Audio API audio capture for Electron renderer process
// Runs in a hidden BrowserWindow
import type { AudioDevice } from '../types/ipc';

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let processorNode: ScriptProcessorNode | null = null;
let audioBuffer: Float32Array[] = [];
let streamingCapture: StreamingCapture | null = null;
let streamingCallbacks: Pick<StreamingRecordingOptions, 'onPcmChunk' | 'onRealtimeDisabled'> | null = null;
const AUDIO_LEVEL_TELEMETRY_INTERVAL_MS = 50;
const STREAM_SAMPLE_RATE = 16_000;
const STREAM_CHUNK_SAMPLES = 320;
/** One second of buffered audio at 16 kHz with 320-sample chunks. */
export const MAX_IN_FLIGHT_PCM_CHUNKS = 50;

export interface StreamingPcmChunk {
  recordingSessionId: string;
  sequence: number;
  pcm: Uint8Array;
}

export interface StreamingRecordingOptions {
  recordingSessionId: string;
  maxInFlightChunks: number;
  onPcmChunk: (chunk: StreamingPcmChunk) => void;
  onRealtimeDisabled: () => void;
}

interface StreamingCapture {
  readonly realtimeEnabled: boolean;
  push(channels: Float32Array[], sampleRate: number): StreamingPcmChunk[];
  acknowledge(sequence: number): void;
  finish(): Uint8Array;
}

function createStreamingCapture(options: {
  recordingSessionId: string;
  maxInFlightChunks: number;
}): StreamingCapture {
  let realtimeEnabled = true;
  let sequence = 0;
  let sourceSampleRate: number | null = null;
  let resampleAccumulator = 0;
  let pendingSamples: number[] = [];
  let retainedSamples: number[] = [];
  const inFlight = new Set<number>();

  const appendSample = (sample: number): void => {
    const clamped = Math.max(-1, Math.min(1, sample));
    const pcm16 = Math.trunc(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    pendingSamples.push(pcm16);
    retainedSamples.push(pcm16);
  };

  return {
    get realtimeEnabled() {
      return realtimeEnabled;
    },
    push(channels, sampleRate) {
      if (!Number.isFinite(sampleRate) || sampleRate <= 0 || channels.length === 0) return [];
      if (sourceSampleRate === null) sourceSampleRate = sampleRate;
      if (sourceSampleRate !== sampleRate) {
        realtimeEnabled = false;
        pendingSamples.length = 0;
        return [];
      }

      const frameCount = Math.min(...channels.map((channel) => channel.length));
      for (let index = 0; index < frameCount; index += 1) {
        let mono = 0;
        for (const channel of channels) mono += channel[index] ?? 0;
        mono /= channels.length;
        resampleAccumulator += STREAM_SAMPLE_RATE;
        while (resampleAccumulator >= sampleRate) {
          appendSample(mono);
          resampleAccumulator -= sampleRate;
        }
      }

      const chunks: StreamingPcmChunk[] = [];
      while (pendingSamples.length >= STREAM_CHUNK_SAMPLES) {
        if (!realtimeEnabled) break;
        if (inFlight.size >= options.maxInFlightChunks) {
          realtimeEnabled = false;
          pendingSamples.length = 0;
          break;
        }
        const samples = pendingSamples.splice(0, STREAM_CHUNK_SAMPLES);
        const pcm = pcm16Bytes(samples);
        const chunkSequence = sequence;
        sequence += 1;
        inFlight.add(chunkSequence);
        chunks.push({ recordingSessionId: options.recordingSessionId, sequence: chunkSequence, pcm });
      }
      return chunks;
    },
    acknowledge(acknowledgedSequence) {
      inFlight.delete(acknowledgedSequence);
    },
    finish() {
      const wav = encodePcm16Wav(retainedSamples, STREAM_SAMPLE_RATE);
      pendingSamples = [];
      retainedSamples = [];
      inFlight.clear();
      return wav;
    },
  };
}

let isRecording = false;
let isStreamPrepared = false;
let latestAudioLevel = 0;
let levelTelemetryTimer: ReturnType<typeof setInterval> | null = null;
let inputSampleRate = 16000;
let inputChannels = 1;
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
  const constraints: MediaStreamConstraints = {
    audio: {
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };

  const deviceId = getDeviceId();
  if (deviceId) {
    (constraints.audio as MediaTrackConstraints).deviceId = { exact: deviceId };
  }

  return constraints;
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
  console.log('Audio stream prepared');
  window.electronAPI?.send('audio-stream-ready');
}

function stopLevelTelemetry(): void {
  if (levelTelemetryTimer) {
    clearInterval(levelTelemetryTimer);
    levelTelemetryTimer = null;
  }
}

function startLevelTelemetry(): void {
  stopLevelTelemetry();
  window.electronAPI?.send('audio-level-changed', latestAudioLevel);
  levelTelemetryTimer = setInterval(() => {
    window.electronAPI?.send('audio-level-changed', latestAudioLevel);
  }, AUDIO_LEVEL_TELEMETRY_INTERVAL_MS);
}

function teardownCapture(): void {
  stopLevelTelemetry();
  if (processorNode) {
    processorNode.disconnect();
    processorNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
}

export async function recreateStream(deviceId: string | null): Promise<void> {
  setSelectedDeviceId(deviceId);
  teardownCapture();
  isStreamPrepared = false;
  await prepareStream();
}

export async function startRecording(options?: StreamingRecordingOptions): Promise<void> {
  if (isRecording) return;

  audioBuffer = [];
  streamingCapture = options ? createStreamingCapture(options) : null;
  streamingCallbacks = options ?? null;
  latestAudioLevel = 0;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(buildConstraints());
    hasAudioPermission = true;
  } catch (err) {
    audioBuffer = [];
    streamingCapture = null;
    streamingCallbacks = null;
    console.error('Failed to open microphone:', err);
    throw err;
  }

  try {
    audioContext = new AudioContext({
      sampleRate: 16000,
    });

    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);

    processorNode.onaudioprocess = (event) => {
      if (!isRecording) return;

      const channelCount = Math.max(1, event.inputBuffer.numberOfChannels ?? 1);
      const channels = Array.from(
        { length: channelCount },
        (_, channel) => new Float32Array(event.inputBuffer.getChannelData(channel)),
      );
      const buffer = channels[0] ?? new Float32Array();
      if (!streamingCapture) audioBuffer.push(buffer);

      if (streamingCapture && streamingCallbacks) {
        const wasRealtimeEnabled = streamingCapture.realtimeEnabled;
        for (const chunk of streamingCapture.push(channels, inputSampleRate)) {
          streamingCallbacks.onPcmChunk(chunk);
        }
        if (wasRealtimeEnabled && !streamingCapture.realtimeEnabled) {
          streamingCallbacks.onRealtimeDisabled();
        }
      }

      const sum = buffer.reduce((acc, val) => acc + Math.abs(val), 0);
      const avg = buffer.length > 0 ? sum / buffer.length : 0;
      latestAudioLevel = Math.min(avg * 10, 1);
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    inputSampleRate = audioContext.sampleRate;
    inputChannels = 1;
    isRecording = true;
    isStreamPrepared = true;
    startLevelTelemetry();
    console.log(`Recording started at ${inputSampleRate} Hz`);
  } catch (error) {
    isRecording = false;
    audioBuffer = [];
    streamingCapture = null;
    streamingCallbacks = null;
    teardownCapture();
    throw error;
  }
}

export function stopRecording(): Uint8Array {
  isRecording = false;
  teardownCapture();

  const wavData = streamingCapture
    ? streamingCapture.finish()
    : encodeWAV(audioBuffer, inputSampleRate, inputChannels);
  console.log(`Recording stopped with ${audioBuffer.length} audio chunks and ${wavData.byteLength} WAV bytes`);
  audioBuffer = [];
  streamingCapture = null;
  streamingCallbacks = null;
  latestAudioLevel = 0;

  return wavData;
}

export function acknowledgeRealtimeChunk(sequence: number): void {
  streamingCapture?.acknowledge(sequence);
}

function encodeWAV(
  buffers: Float32Array[],
  sampleRate: number,
  numChannels: number
): Uint8Array {
  const merged = mergeBuffers(buffers);
  const length = merged.length * numChannels * 2 + 44;
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);

  // RIFF identifier
  writeString(view, 0, 'RIFF');
  // file length
  view.setUint32(4, 36 + merged.length * numChannels * 2, true);
  // RIFF type
  writeString(view, 8, 'WAVE');
  // format chunk identifier
  writeString(view, 12, 'fmt ');
  // format chunk length
  view.setUint32(16, 16, true);
  // sample format (raw)
  view.setUint16(20, 1, true);
  // channel count
  view.setUint16(22, numChannels, true);
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate (sample rate * block align)
  view.setUint32(28, sampleRate * numChannels * 2, true);
  // block align (channel count * bytes per sample)
  view.setUint16(32, numChannels * 2, true);
  // bits per sample
  view.setUint16(34, 16, true);
  // data chunk identifier
  writeString(view, 36, 'data');
  // data chunk length
  view.setUint32(40, merged.length * numChannels * 2, true);

  // Write interleaved data
  const offset = 44;
  for (let i = 0; i < merged.length; i++) {
    const sample = Math.max(-1, Math.min(1, merged[i]));
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(offset + i * 2, int16, true);
  }

  return new Uint8Array(buffer);
}

function mergeBuffers(buffers: Float32Array[]): Float32Array {
  const totalLength = buffers.reduce((acc, buf) => acc + buf.length, 0);
  const result = new Float32Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(buf, offset);
    offset += buf.length;
  }
  return result;
}

function pcm16Bytes(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index] ?? 0, true);
  }
  return bytes;
}

function encodePcm16Wav(samples: number[], sampleRate: number): Uint8Array {
  const pcm = pcm16Bytes(samples);
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}

function writeString(view: DataView, offset: number, string: string): void {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

export const __audioCaptureTestUtils = {
  createStreamingCapture,
  encodeWAV,
  mergeBuffers,
};
