import { z } from 'zod';
import { createLocalRecognizer } from './managed-local-recognizer';
import { decodePcm16Wave } from './managed-local-wave';
import { isManagedLocalThreadCount } from './managed-local-threads';
import { decodeManagedLocal, type LocalRecognizer } from './managed-local-decode';
import { createIncrementalDecoder } from './managed-local-incremental';
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
      recognizer = await createLocalRecognizer(message.runtime ?? {
        model: 'parakeet', backend: 'cpu', modelPath: message.modelPath,
      }, message.numThreads);
      // A real encode/decode catches missing CUDA dependencies and incompatible graphs before recording.
      await decodeManagedLocal(recognizer, { samples: new Float32Array(SAMPLE_RATE), sampleRate: SAMPLE_RATE });
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
    const wave = decodePcm16Wave(message.audio);
    const raw = await decodeManagedLocal(recognizer, wave, message.dictionary);
    const text = message.removeFillerWords ? cleanFillerWords(raw) : raw;
    port.postMessage({ kind: 'result', requestId: message.requestId,
      text: recognizer.format?.(text, message.dictionary) ?? text });
  } catch (error) {
    port.postMessage({ kind: 'error', requestId: message.requestId, message: safeError(error, 'Local transcription failed.') });
  }
}

// One recording at a time streams PCM16 here so decoding can start before the user stops.
let incremental: { id: string; decoder: ReturnType<typeof createIncrementalDecoder>;
  format: (text: string) => string } | null = null;

function handleIncremental(message: IncrementalMessage): void {
  if (message.kind === 'incremental-start') {
    incremental?.decoder.cancel();
    const model = recognizer;
    incremental = model ? {
      id: message.requestId,
      format: raw => {
        const text = message.removeFillerWords ? cleanFillerWords(raw) : raw;
        return model.format?.(text, message.dictionary) ?? text;
      },
      decoder: createIncrementalDecoder(samples => decodeManagedLocal(model, { samples, sampleRate: SAMPLE_RATE }, message.dictionary), SAMPLE_RATE),
    } : null;
    return;
  }
  const session = incremental?.id === message.requestId ? incremental : null;
  if (message.kind === 'incremental-push') {
    session?.decoder.push(pcm16ToFloat(message.audio));
    return;
  }
  if (message.kind === 'incremental-cancel') {
    if (session) {
      session.decoder.cancel();
      incremental = null;
    }
    return;
  }
  if (!session) {
    port.postMessage({ kind: 'error', requestId: message.requestId, message: 'Incremental transcription was not started.' });
    return;
  }
  incremental = null;
  session.decoder.finish().then(session.format).then(
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
  | { kind: 'incremental-start'; requestId: string; dictionary: string[]; removeFillerWords: boolean }
  | { kind: 'incremental-finish' | 'incremental-cancel'; requestId: string }
  | { kind: 'incremental-push'; requestId: string; audio: ArrayBuffer };

function isIncrementalMessage(message: unknown): message is IncrementalMessage {
  if (!message || typeof message !== 'object' || !('kind' in message) || !('requestId' in message)) return false;
  if (typeof message.requestId !== 'string') return false;
  if (message.kind === 'incremental-start') return 'dictionary' in message && localVocabularySchema.safeParse(message.dictionary).success
    && 'removeFillerWords' in message && typeof message.removeFillerWords === 'boolean';
  if (message.kind === 'incremental-push') return 'audio' in message && message.audio instanceof ArrayBuffer;
  return message.kind === 'incremental-finish' || message.kind === 'incremental-cancel';
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
