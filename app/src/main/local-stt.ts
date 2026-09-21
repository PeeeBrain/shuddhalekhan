import { availableParallelism } from 'os';
import { join } from 'path';
import { OfflineRecognizer } from 'sherpa-onnx-node';
import { decodePcm16Wave } from './managed-local-wave';

const port = process.parentPort;
if (!port) throw new Error('Local speech recognition must run as an Electron utility process.');

let recognizer: OfflineRecognizer | null = null;

port.on('message', (event) => {
  void handleMessage(event.data);
});

async function handleMessage(message: unknown): Promise<void> {
  if (isLoadMessage(message)) {
    const started = performance.now();
    try {
      recognizer = await OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16_000, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: join(message.modelPath, 'encoder.int8.onnx'),
            decoder: join(message.modelPath, 'decoder.int8.onnx'),
            joiner: join(message.modelPath, 'joiner.int8.onnx'),
          },
          tokens: join(message.modelPath, 'tokens.txt'),
          numThreads: Math.max(1, Math.min(4, availableParallelism() - 1)),
          provider: 'cpu',
          modelType: 'nemo_transducer',
          debug: false,
        },
      });
      port.postMessage({ kind: 'ready', loadMilliseconds: performance.now() - started });
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
  const started = performance.now();
  try {
    const wave = decodePcm16Wave(message.audio);
    const stream = recognizer.createStream();
    stream.acceptWaveform(wave);
    const result = await recognizer.decodeAsync(stream);
    port.postMessage({
      kind: 'result',
      requestId: message.requestId,
      text: result.text,
      transcriptionMilliseconds: performance.now() - started,
      audioDurationMilliseconds: wave.samples.length / wave.sampleRate * 1000,
    });
  } catch (error) {
    port.postMessage({ kind: 'error', requestId: message.requestId, message: safeError(error, 'Local transcription failed.') });
  }
}

function isLoadMessage(message: unknown): message is { kind: 'load'; modelPath: string } {
  return Boolean(
    message && typeof message === 'object'
    && 'kind' in message && message.kind === 'load'
    && 'modelPath' in message && typeof message.modelPath === 'string',
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
