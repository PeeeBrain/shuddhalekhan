// Web Audio API audio capture for Electron renderer process
// Runs in a hidden BrowserWindow
import type { AudioDevice } from '../types/ipc';

const AUDIO_LEVEL_THROTTLE_MS = 33;

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let processorNode: ScriptProcessorNode | null = null;
let audioBuffer: Float32Array[] = [];
let isRecording = false;
let isStreamPrepared = false;
let inputSampleRate = 16000;
let inputChannels = 1;
let selectedDeviceId: string | null = null;
let hasAudioPermission = false;
let lastLevelEmittedAt = 0;

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
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device) => ({
      deviceId: device.deviceId,
      label: device.label,
      kind: 'audioinput',
    }));
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

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(buildConstraints());
    hasAudioPermission = true;
  } catch (err) {
    console.error('Failed to open microphone:', err);
    throw err;
  }

  audioContext = new AudioContext({
    sampleRate: 16000,
  });

  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);

  processorNode.onaudioprocess = (event) => {
    if (!isRecording) return;

    const inputData = event.inputBuffer.getChannelData(0);
    const buffer = new Float32Array(inputData);
    audioBuffer.push(buffer);

    const sum = buffer.reduce((acc, val) => acc + Math.abs(val), 0);
    const avg = sum / buffer.length;
    const level = Math.min(avg * 10, 1);

    const now = Date.now();
    if (now - lastLevelEmittedAt >= AUDIO_LEVEL_THROTTLE_MS) {
      lastLevelEmittedAt = now;
      window.electronAPI?.send('audio-level-changed', level);
    }
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioContext.destination);

  inputSampleRate = audioContext.sampleRate;
  inputChannels = 1;
  isStreamPrepared = true;
  console.log(`Audio stream prepared at ${inputSampleRate} Hz`);
  window.electronAPI?.send('audio-stream-ready');
}

function teardownStream(): void {
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
  isStreamPrepared = false;
}

export async function recreateStream(deviceId: string | null): Promise<void> {
  setSelectedDeviceId(deviceId);
  teardownStream();
  await prepareStream();
}

export async function startRecording(): Promise<void> {
  if (isRecording) return;

  if (!isStreamPrepared) {
    await prepareStream();
  }

  audioBuffer = [];
  lastLevelEmittedAt = 0;
  isRecording = true;
  console.log(`Recording started at ${inputSampleRate} Hz`);
}

export function stopRecording(): Uint8Array {
  isRecording = false;

  const wavData = encodeWAV(audioBuffer, inputSampleRate, inputChannels);
  console.log(`[DIAGNOSTIC #80] audio-capture stopRecording: ${audioBuffer.length} chunks, ${wavData.byteLength} WAV bytes`);
  window.electronAPI?.send('recording:diagnostic', {
    chunks: audioBuffer.length,
    byteLength: wavData.byteLength,
  });
  audioBuffer = [];

  return wavData;
}

export function discardRecording(): void {
  isRecording = false;
  audioBuffer = [];
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

function writeString(view: DataView, offset: number, string: string): void {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

export const __audioCaptureTestUtils = {
  encodeWAV,
  mergeBuffers,
};
