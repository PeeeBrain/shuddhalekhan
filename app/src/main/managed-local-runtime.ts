import { randomUUID } from 'crypto';
import { join } from 'path';
import { TranscriptionFailure, type Transcriber } from './transcription';
import { resolveManagedLocalThreads } from './managed-local-threads';
import type { LocalRuntime } from './managed-local-engine';

export const RECOGNITION_TIMEOUT_MS = 120_000;

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
  numThreads = resolveManagedLocalThreads(null),
  startProcess = defaultStartProcess,
  loadTimeoutMs = 120_000,
  transcriptionTimeoutMs = RECOGNITION_TIMEOUT_MS,
  runtime,
}: {
  getModelPath: () => Promise<string>;
  numThreads?: number;
  startProcess?: () => RuntimeProcess | Promise<RuntimeProcess>;
  loadTimeoutMs?: number;
  transcriptionTimeoutMs?: number;
  runtime?: LocalRuntime;
}) {
  let child: RuntimeProcess | null = null;
  let ready: Promise<void> | null = null;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  let loadTimeout: ReturnType<typeof setTimeout> | null = null;
  let activeStartup: object | null = null;
  const pending = new Map<string, PendingRequest>();
  let queue: Promise<unknown> = Promise.resolve();

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
      resolveReady?.();
      resolveReady = null;
      rejectReady = null;
      return;
    }
    if (message.kind === 'load-error') {
      const error = new TranscriptionFailure(
        'model',
        runtime?.backend === 'cuda'
          ? 'GPU speech recognition could not start. Check the NVIDIA driver and GPU setup, or choose CPU in Settings.'
          : 'Local speech recognition could not load. Delete and reinstall the model in Settings.',
      );
      if (child) reset(child, error, true);
      return;
    }
    const request = pending.get(message.requestId);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(message.requestId);
    if (message.kind === 'result') {
      request.resolve(message.text);
    }
    else request.reject(new TranscriptionFailure(
      'model',
      'Local transcription failed. Retry Dictation; if it happens again, repair the model in Settings.',
    ));
  };

  const ensureReady = (): Promise<void> => {
    if (ready) {
      const startup = ready;
      return startup.then(() => { if (ready !== startup) return ensureReady(); });
    }
    const startupToken = {};
    activeStartup = startupToken;
    const startup = (async () => {
      try {
        const modelPath = await getModelPath();
        if (activeStartup !== startupToken) throw new TranscriptionFailure('model', 'Local speech recognition stopped.');
        const process = await startProcess();
        if (activeStartup !== startupToken) {
          process.kill();
          throw new TranscriptionFailure('model', 'Local speech recognition stopped.');
        }
        child = process;
        const loaded = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        process.on('message', onMessage);
        process.on('exit', (code) => {
          if (child !== process) return;
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
        process.postMessage({ kind: 'load', modelPath, numThreads, ...(runtime ? { runtime } : {}) });
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
    return startup.then(ensureReady);
  };

  const awaitResult = (requestId: string): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const process = child;
        const error = new TranscriptionFailure('model', 'Local transcription timed out. Retry Dictation.');
        if (process) reset(process, error, true);
        else reject(error);
      }, transcriptionTimeoutMs);
      pending.set(requestId, { resolve, reject, timeout });
    });
  };

  const transcriber: Transcriber & { warmup(): Promise<void>; shutdown(): Promise<void> } = {
    id: 'managed-local',
    capabilities: {
      maxDurationSeconds: null,
    },
    transcribe({ audio, recognition, signal }) {
      const { dictionary, removeFillerWords } = structuredClone(recognition);
      // Native decodes cannot be interrupted, so the worker gets one at a time. An aborted caller returns at
      // once; its decode drains here before the next one is sent, and work still queued behind it is skipped.
      const job = queue.then(async () => {
        signal?.throwIfAborted();
        await ensureReady();
        signal?.throwIfAborted();
        if (!child) throw new TranscriptionFailure('model', 'Local speech recognition is unavailable.');
        const requestId = randomUUID();
        const result = awaitResult(requestId);
        child.postMessage({ kind: 'transcribe', requestId, audio: audio.slice().buffer, dictionary, removeFillerWords });
        return (await result).trim();
      });
      queue = job.catch(() => undefined);
      if (!signal) return job;
      return new Promise<string>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        job.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
      });
    },
    warmup: ensureReady,
    async shutdown() {
      const process = child;
      if (process) reset(process, new TranscriptionFailure('model', 'Local speech recognition stopped.'), true);
      else { activeStartup = null; ready = null; }
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
  | { kind: 'ready' }
  | { kind: 'load-error'; message: string }
  | { kind: 'result'; requestId: string; text: string }
  | { kind: 'error'; requestId: string; message: string };

function isRuntimeResponse(message: unknown): message is RuntimeResponse {
  if (!message || typeof message !== 'object' || !('kind' in message)) return false;
  const kind = message.kind;
  if (kind === 'ready') return true;
  if (kind === 'load-error') return 'message' in message && typeof message.message === 'string';
  if (kind === 'result') {
    return 'requestId' in message && typeof message.requestId === 'string'
      && 'text' in message && typeof message.text === 'string';
  }
  if (kind === 'error') {
    return 'requestId' in message && typeof message.requestId === 'string'
      && 'message' in message && typeof message.message === 'string';
  }
  return false;
}
