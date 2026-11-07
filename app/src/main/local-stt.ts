import { z } from 'zod';
import { createLocalRecognizer } from './managed-local-recognizer';
import { decodePcm16Wave } from './managed-local-wave';
import { isManagedLocalThreadCount } from './managed-local-threads';
import { decodeManagedLocal, type LocalRecognizer } from './managed-local-decode';
import { localVocabularySchema } from './managed-local-vocabulary';
import { cleanFillerWords } from './transcription';

const SAMPLE_RATE = 16_000;

const port = process.parentPort;
if (!port) throw new Error('Local speech recognition must run as an Electron utility process.');

let recognizer: LocalRecognizer | null = null;

port.on('message', (event) => {
  void handleMessage(event.data);
});

async function handleMessage(message: unknown): Promise<void> {
  if (isLoadMessage(message)) {
    try {
      const runtime = message.runtime ?? { model: 'parakeet' as const, backend: 'cpu' as const, modelPath: message.modelPath };
      recognizer = await createLocalRecognizer(runtime, message.numThreads);
      // A real encode/decode catches missing CUDA dependencies and incompatible graphs before recording.
      await decodeManagedLocal(recognizer, { samples: new Float32Array(SAMPLE_RATE), sampleRate: SAMPLE_RATE });
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
    const raw = await decodeManagedLocal(recognizer, wave, message.dictionary);
    const text = message.removeFillerWords ? cleanFillerWords(raw) : raw;
    port.postMessage({ kind: 'result', requestId: message.requestId,
      text: recognizer.format?.(text, message.dictionary) ?? text });
  } catch (error) {
    port.postMessage({ kind: 'error', requestId: message.requestId, message: safeError(error, 'Local transcription failed.') });
  }
}

const runtimeSchema = z.object({
  model: z.enum(['parakeet', 'granite']), backend: z.enum(['cpu', 'cuda']), modelPath: z.string(), libraryPaths: z.array(z.string()).optional(),
  contextual: z.boolean().optional(),
  formattingPath: z.string().optional(),
});

function isLoadMessage(message: unknown): message is {
  kind: 'load'; modelPath: string; numThreads: number; runtime?: z.infer<typeof runtimeSchema>;
} {
  return Boolean(
    message && typeof message === 'object'
    && 'kind' in message && message.kind === 'load'
    && 'modelPath' in message && typeof message.modelPath === 'string'
    && 'numThreads' in message && isManagedLocalThreadCount(message.numThreads)
    && (!('runtime' in message) || runtimeSchema.safeParse(message.runtime).success),
  );
}

function isTranscribeMessage(message: unknown): message is {
  kind: 'transcribe'; requestId: string; audio: ArrayBuffer; dictionary: string[]; removeFillerWords: boolean;
} {
  return Boolean(
    message && typeof message === 'object'
    && 'kind' in message && message.kind === 'transcribe'
    && 'requestId' in message && typeof message.requestId === 'string'
    && 'audio' in message && message.audio instanceof ArrayBuffer
    && 'dictionary' in message && localVocabularySchema.safeParse(message.dictionary).success
    && 'removeFillerWords' in message && typeof message.removeFillerWords === 'boolean',
  );
}

function safeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
