import { OfflineRecognizer } from 'sherpa-onnx-node';
import { decodePcm16Wave } from './managed-local-wave';
import { managedLocalRecognizerConfig } from './managed-local-model';
import { isManagedLocalThreadCount } from './managed-local-threads';

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

  if (!isTranscribeMessage(message)) return;
  if (!recognizer) {
    port.postMessage({ kind: 'error', requestId: message.requestId, message: 'The local speech model is not loaded.' });
    return;
  }
  try {
    const wave = decodePcm16Wave(message.audio);
    const stream = recognizer.createStream();
    stream.acceptWaveform(wave);
    const result = await recognizer.decodeAsync(stream);
    port.postMessage({ kind: 'result', requestId: message.requestId, text: result.text });
  } catch (error) {
    port.postMessage({ kind: 'error', requestId: message.requestId, message: safeError(error, 'Local transcription failed.') });
  }
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
