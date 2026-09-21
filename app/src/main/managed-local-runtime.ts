import { randomUUID } from 'crypto';
import { join } from 'path';
import { cleanFillerWords, TranscriptionFailure, type Transcriber } from './transcription';
import { emitPerformanceMarker } from './performance/marker-collector';

type RuntimeProcess = {
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
};

type PendingRequest = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export function createManagedLocalTranscriber({
  getModelPath,
  startProcess = defaultStartProcess,
  loadTimeoutMs = 120_000,
  transcriptionTimeoutMs = 120_000,
}: {
  getModelPath: () => Promise<string>;
  startProcess?: () => RuntimeProcess | Promise<RuntimeProcess>;
  loadTimeoutMs?: number;
  transcriptionTimeoutMs?: number;
}) {
  let child: RuntimeProcess | null = null;
  let ready: Promise<void> | null = null;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  let loadTimeout: ReturnType<typeof setTimeout> | null = null;
  let activeStartup: object | null = null;
  const pending = new Map<string, PendingRequest>();

  const rejectPending = (error: Error): void => {
    rejectReady?.(error);
    resolveReady = null;
    rejectReady = null;
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };

  const reset = (process: RuntimeProcess, error: Error, kill: boolean): void => {
    if (child !== process) return;
    child = null;
    ready = null;
    activeStartup = null;
    if (loadTimeout) clearTimeout(loadTimeout);
    loadTimeout = null;
    rejectPending(error);
    if (kill) process.kill();
  };

  const onMessage = (message: unknown): void => {
    if (!isRuntimeResponse(message)) return;
    if (message.kind === 'ready') {
      if (loadTimeout) clearTimeout(loadTimeout);
      loadTimeout = null;
      emitPerformanceMarker('managed-local.model.loaded', { loadMilliseconds: message.loadMilliseconds });
      resolveReady?.();
      resolveReady = null;
      rejectReady = null;
      return;
    }
    if (message.kind === 'load-error') {
      const error = new TranscriptionFailure(
        'model',
        'Local speech recognition could not load. Delete and reinstall the model in Settings.',
      );
      if (child) reset(child, error, true);
      return;
    }
    const request = pending.get(message.requestId);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(message.requestId);
    if (message.kind === 'result') {
      emitPerformanceMarker('managed-local.transcription.completed', {
        transcriptionMilliseconds: message.transcriptionMilliseconds,
        audioDurationMilliseconds: message.audioDurationMilliseconds,
      });
      request.resolve(message.text);
    }
    else request.reject(new TranscriptionFailure(
      'model',
      'Local transcription failed. Retry Dictation; if it happens again, repair the model in Settings.',
    ));
  };

  const ensureReady = (): Promise<void> => {
    if (ready) return ready;
    const startupToken = {};
    activeStartup = startupToken;
    const startup = (async () => {
      try {
        const modelPath = await getModelPath();
        const process = await startProcess();
        child = process;
        const loaded = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        process.on('message', onMessage);
        process.on('exit', (code) => {
          if (child !== process) return;
          emitPerformanceMarker('managed-local.runtime.exited', { code });
          reset(process, new TranscriptionFailure(
            'model',
            code === 0
              ? 'Local speech recognition stopped.'
              : 'Local speech recognition stopped unexpectedly. Retry Dictation.',
          ), false);
        });
        loadTimeout = setTimeout(() => {
          reset(process, new TranscriptionFailure(
            'model',
            'Local speech recognition timed out while loading. Retry Dictation.',
          ), true);
        }, loadTimeoutMs);
        process.postMessage({ kind: 'load', modelPath });
        await loaded;
      } catch (error) {
        if (activeStartup === startupToken) {
          activeStartup = null;
          ready = null;
        }
        throw error;
      }
    })();
    ready = startup;
    return startup;
  };

  const transcriber: Transcriber & { warmup(): Promise<void>; shutdown(): Promise<void> } = {
    id: 'managed-local',
    capabilities: {
      translation: false,
      automaticLanguageDetection: true,
      dictionaryHints: false,
      authentication: 'none',
      maxDurationSeconds: null,
    },
    async transcribe({ audio, recognition }) {
      await ensureReady();
      if (!child) throw new TranscriptionFailure('model', 'Local speech recognition is unavailable.');
      const requestId = randomUUID();
      const result = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const process = child;
          const error = new TranscriptionFailure('model', 'Local transcription timed out. Retry Dictation.');
          if (process) reset(process, error, true);
          else reject(error);
        }, transcriptionTimeoutMs);
        pending.set(requestId, { resolve, reject, timeout });
      });
      child.postMessage({ kind: 'transcribe', requestId, audio: audio.slice().buffer });
      const text = (await result).trim();
      return recognition.removeFillerWords ? cleanFillerWords(text) : text;
    },
    warmup: ensureReady,
    async shutdown() {
      const process = child;
      if (process) reset(process, new TranscriptionFailure('model', 'Local speech recognition stopped.'), true);
    },
  };

  return transcriber;
}

async function defaultStartProcess(): Promise<RuntimeProcess> {
  const { utilityProcess } = await import('electron');
  return utilityProcess.fork(join(__dirname, 'local-stt.cjs'), [], {
    serviceName: 'Shuddhalekhan local speech recognition',
  });
}

type RuntimeResponse =
  | { kind: 'ready'; loadMilliseconds: number }
  | { kind: 'load-error'; message: string }
  | { kind: 'result'; requestId: string; text: string; transcriptionMilliseconds: number; audioDurationMilliseconds?: number }
  | { kind: 'error'; requestId: string; message: string };

function isRuntimeResponse(message: unknown): message is RuntimeResponse {
  if (!message || typeof message !== 'object' || !('kind' in message)) return false;
  const kind = message.kind;
  if (kind === 'ready') return 'loadMilliseconds' in message && typeof message.loadMilliseconds === 'number';
  if (kind === 'load-error') return 'message' in message && typeof message.message === 'string';
  if (kind === 'result') {
    return 'requestId' in message && typeof message.requestId === 'string'
      && 'text' in message && typeof message.text === 'string'
      && 'transcriptionMilliseconds' in message && typeof message.transcriptionMilliseconds === 'number'
      && (!('audioDurationMilliseconds' in message) || typeof message.audioDurationMilliseconds === 'number');
  }
  if (kind === 'error') {
    return 'requestId' in message && typeof message.requestId === 'string'
      && 'message' in message && typeof message.message === 'string';
  }
  return false;
}
