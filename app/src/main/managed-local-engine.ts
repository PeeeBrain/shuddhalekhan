import type { ManagedLocalModelSnapshot, ManagedLocalSelection } from '../types/ipc';
import { TranscriptionFailure, type Transcriber } from './transcription';
import { createManagedLocalTranscriber } from './managed-local-runtime';

export interface LocalRuntime {
  model: 'parakeet' | 'granite';
  backend: 'cpu' | 'cuda';
  modelPath: string;
  runtimePath?: string;
}

type Worker = ReturnType<typeof createManagedLocalTranscriber>;
type RuntimeStatus = ManagedLocalModelSnapshot['runtime'];
type EngineSettings = { selection: ManagedLocalSelection; numThreads: number; revision: number };

/** Holds a worker for the whole recording, including pause decoding and cancellation. */
export function createManagedLocalEngine({
  getSettings,
  getCandidates,
  createWorker,
  onStatus,
}: {
  getSettings: () => EngineSettings;
  getCandidates: (selection: ManagedLocalSelection) => Promise<LocalRuntime[]>;
  createWorker: (runtime: LocalRuntime, numThreads: number) => Worker;
  onStatus: (status: RuntimeStatus, settings: EngineSettings) => void;
}) {
  let current: { key: string; worker: Worker; runtime: LocalRuntime; settings: EngineSettings } | null = null;
  let selecting: Promise<void> | null = null;
  let leases = 0;
  const drained: (() => void)[] = [];
  let generation = 0;
  let failedGpuKey: string | null = null;
  let loadingWorker: Worker | null = null;

  const key = () => JSON.stringify(getSettings());
  const release = () => {
    leases--;
    if (!leases) {
      drained.splice(0).forEach(resolve => resolve());
    }
  };
  const ensure = async (): Promise<NonNullable<typeof current>> => {
    if (selecting) await selecting;
    const settings = structuredClone(getSettings());
    const desiredKey = JSON.stringify(settings);
    if (current?.key === desiredKey) return current;
    if (leases) {
      await new Promise<void>(resolve => drained.push(resolve));
      return ensure();
    }
    const token = generation;
    selecting = (async () => {
      await current?.worker.shutdown();
      current = null;
      onStatus({ status: 'loading', backend: null, message: 'Starting local speech recognition…' }, settings);
      let failure = '';
      try {
        const candidates = await getCandidates(settings.selection);
        for (const runtime of candidates) {
          if (token !== generation) throw new Error('Local speech recognition stopped.');
          if (runtime.backend === 'cuda' && failedGpuKey === desiredKey
            && settings.selection.devices[settings.selection.model] === 'auto') continue;
          const worker = createWorker(runtime, settings.numThreads);
          loadingWorker = worker;
          try {
            await worker.warmup();
            if (token !== generation) throw new Error('Local speech recognition stopped.');
            current = { key: desiredKey, worker, runtime, settings };
            onStatus({ status: 'ready', backend: runtime.backend,
              message: runtime.backend === 'cuda' ? 'Using dedicated NVIDIA GPU.'
                : failure || failedGpuKey === desiredKey
                  ? 'Using CPU after GPU startup or inference failed. Select Dedicated GPU to retry.'
                  : settings.selection.devices[settings.selection.model] === 'cpu' ? 'Using CPU.'
                    : 'Using CPU. Auto uses GPU only after GPU setup is installed and verified.' }, settings);
            return;
          } catch (error) {
            await worker.shutdown();
            if (token !== generation) throw error;
            failure = error instanceof Error ? error.message : 'Local speech recognition could not start.';
            if (runtime.backend === 'cuda') failedGpuKey = desiredKey;
          } finally {
            if (loadingWorker === worker) loadingWorker = null;
          }
        }
        throw new TranscriptionFailure('model', failure || 'Install the selected local speech model in Settings.');
      } catch (error) {
        if (token === generation) onStatus({ status: 'error', backend: null,
          message: error instanceof Error ? error.message : 'Local speech recognition could not start.' }, settings);
        throw error;
      }
    })();
    try { await selecting; } finally { selecting = null; }
    if (!current) throw new Error('Local speech recognition is unavailable.');
    if (key() !== desiredKey) return ensure();
    return current;
  };

  const acquire = async () => {
    const selected = await ensure();
    leases++;
    let released = false;
    return { ...selected, release() { if (!released) { released = true; release(); } } };
  };
  const failed = async (selected: NonNullable<typeof current>) => {
    if (selected.runtime.backend === 'cuda') failedGpuKey = selected.key;
    if (current === selected || current?.worker === selected.worker) current = null;
    await selected.worker.shutdown();
    onStatus({ status: 'error', backend: null,
      message: selected.runtime.backend === 'cuda'
        ? 'GPU inference failed. Auto will retry the completed recording on CPU; dedicated GPU requires GPU setup repair.'
        : 'Local CPU inference failed. Retry Dictation to restart it.' }, selected.settings);
  };

  const transcriber: Transcriber & { warmup(): Promise<void>; shutdown(): Promise<void>; isBusy(): boolean } = {
    id: 'managed-local',
    isBusy: () => leases > 0,
    capabilities: { translation: false, automaticLanguageDetection: true, dictionaryHints: false,
      authentication: 'none', maxDurationSeconds: null },
    async warmup() {
      // Settings can be edited during recording; never wait on or replace its worker here.
      if (leases) return;
      await ensure();
    },
    async transcribe(request) {
      const selected = await acquire();
      try { return await selected.worker.transcribe(request); }
      catch (error) {
        await failed(selected);
        selected.release();
        if (selected.runtime.backend !== 'cuda'
          || getSettings().selection.devices[selected.runtime.model] !== 'auto') throw error;
        const fallback = await acquire();
        try { return await fallback.worker.transcribe(request); } finally { fallback.release(); }
      } finally { selected.release(); }
    },
    startIncremental(request) {
      let cancelled = false;
      const started = acquire().then(selected => {
        if (cancelled) { selected.release(); throw new Error('Recording cancelled.'); }
        const session = selected.worker.startIncremental(request);
        return { selected, session };
      });
      started.catch(() => {});
      return {
        async send(audio) {
          const { selected, session } = await started;
          try { await session.send(audio); }
          catch (error) { await failed(selected); selected.release(); throw error; }
        },
        async finish() {
          const { selected, session } = await started;
          try { return await session.finish(); }
          catch (error) { await failed(selected); throw error; }
          finally { selected.release(); }
        },
        cancel() {
          cancelled = true;
          void started.then(({ selected, session }) => { session.cancel(); selected.release(); }).catch(() => {});
        },
      };
    },
    async shutdown() {
      generation++;
      await loadingWorker?.shutdown();
      await current?.worker.shutdown();
      current = null;
      onStatus({ status: 'idle', backend: null, message: 'Local speech recognition is stopped.' }, getSettings());
    },
  };
  return transcriber;
}
