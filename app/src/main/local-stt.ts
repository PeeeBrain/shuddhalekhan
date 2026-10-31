import { OfflineRecognizer } from 'sherpa-onnx-node';
import { decodePcm16Wave } from './managed-local-wave';
import { managedLocalRecognizerConfig } from './managed-local-model';
import { isManagedLocalThreadCount } from './managed-local-threads';
import { createIncrementalDecoder } from './managed-local-incremental';

const SAMPLE_RATE = 16_000;

const port = process.parentPort;
if (!port) throw new Error('Local speech recognition must run as an Electron utility process.');

let recognizer: OfflineRecognizer | null = null;

port.on('message', (event) => {
  void handleMessage(event.data);
});

async function handleMessage(message: unknown): Promise<void> {
  if (isLoadMessage(message)) {
    try {
      recognizer = await OfflineRecognizer.createAsync(managedLocalRecognizerConfig(message.modelPath, message.numThreads));
      port.postMessage({ kind: 'ready' });
    } catch (error) {
      recognizer = null;
      port.postMessage({ kind: 'load-error', message: safeError(error, 'Could not load the local speech model.') });
    }
    return;
  }

  if (isIncrementalMessage(message)) {
    handleIncremental(message);
    return;
  }

  if (!isTranscribeMessage(message)) return;
  if (!recognizer) {
    port.postMessage({ kind: 'error', requestId: message.requestId, message: 'The local speech model is not loaded.' });
    return;
  }
  try {
    const text = await decode(recognizer, decodePcm16Wave(message.audio));
    port.postMessage({ kind: 'result', requestId: message.requestId, text });
  } catch (error) {
    port.postMessage({ kind: 'error', requestId: message.requestId, message: safeError(error, 'Local transcription failed.') });
  }
}

async function decode(model: OfflineRecognizer, wave: { samples: Float32Array; sampleRate: number }): Promise<string> {
  const stream = model.createStream();
  stream.acceptWaveform(wave);
  return (await model.decodeAsync(stream)).text;
}

// One recording at a time streams PCM16 here so decoding can start before the user stops.
let incremental: { id: string; decoder: ReturnType<typeof createIncrementalDecoder> } | null = null;

function handleIncremental(message: IncrementalMessage): void {
  if (message.kind === 'incremental-start') {
    const model = recognizer;
    incremental = model ? {
      id: message.requestId,
      decoder: createIncrementalDecoder(samples => decode(model, { samples, sampleRate: SAMPLE_RATE }), SAMPLE_RATE),
    } : null;
    return;
  }
  const session = incremental?.id === message.requestId ? incremental : null;
  if (message.kind === 'incremental-push') {
    session?.decoder.push(pcm16ToFloat(message.audio));
    return;
  }
  if (message.kind === 'incremental-cancel') {
    if (session) incremental = null;
    return;
  }
  if (!session) {
    port.postMessage({ kind: 'error', requestId: message.requestId, message: 'Incremental transcription was not started.' });
    return;
  }
  incremental = null;
  session.decoder.finish().then(
    text => port.postMessage({ kind: 'result', requestId: message.requestId, text }),
    error => port.postMessage({ kind: 'error', requestId: message.requestId, message: safeError(error, 'Local transcription failed.') }),
  );
}

function pcm16ToFloat(buffer: ArrayBuffer): Float32Array {
  const pcm = new Int16Array(buffer, 0, buffer.byteLength >> 1);
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
  return samples;
}

type IncrementalMessage =
  | { kind: 'incremental-start' | 'incremental-finish' | 'incremental-cancel'; requestId: string }
  | { kind: 'incremental-push'; requestId: string; audio: ArrayBuffer };

function isIncrementalMessage(message: unknown): message is IncrementalMessage {
  if (!message || typeof message !== 'object' || !('kind' in message) || !('requestId' in message)) return false;
  if (typeof message.requestId !== 'string') return false;
  if (message.kind === 'incremental-push') return 'audio' in message && message.audio instanceof ArrayBuffer;
  return message.kind === 'incremental-start' || message.kind === 'incremental-finish' || message.kind === 'incremental-cancel';
}

function isLoadMessage(message: unknown): message is { kind: 'load'; modelPath: string; numThreads: number } {
  return Boolean(
    message && typeof message === 'object'
    && 'kind' in message && message.kind === 'load'
    && 'modelPath' in message && typeof message.modelPath === 'string'
    && 'numThreads' in message && isManagedLocalThreadCount(message.numThreads),
  );
}

function isTranscribeMessage(message: unknown): message is {
  kind: 'transcribe'; requestId: string; audio: ArrayBuffer;
} {
  return Boolean(
    message && typeof message === 'object'
    && 'kind' in message && message.kind === 'transcribe'
    && 'requestId' in message && typeof message.requestId === 'string'
    && 'audio' in message && message.audio instanceof ArrayBuffer,
  );
}

function safeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
