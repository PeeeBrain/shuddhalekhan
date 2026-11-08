import type { ManagedLocalModelSnapshot, ManagedLocalSelection } from '../types/ipc';
import { TranscriptionFailure, type Transcriber, type TranscriptionRequest } from './transcription';
import { createManagedLocalTranscriber } from './managed-local-runtime';

export interface LocalRuntime {
  model: 'parakeet' | 'granite';
  backend: 'cpu' | 'cuda';
  modelPath: string;
  contextual?: boolean;
  formattingPath?: string;
  /** GPU only: the native library directory first, then the CUDA library directories. */
  libraryPaths?: string[];
}

type Worker = ReturnType<typeof createManagedLocalTranscriber>;
type RuntimeStatus = ManagedLocalModelSnapshot['runtime'];
type EngineSettings = { selection: ManagedLocalSelection; numThreads: number; revision: number; contextual: boolean };
type RuntimePlan = { settings: EngineSettings; candidates: LocalRuntime[] | null };

/** Keeps one local worker warm across recordings and decodes each completed recording once, with its pinned settings. */
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
  let current: { key: string; worker: Worker; runtime: LocalRuntime; settings: EngineSettings; candidates: LocalRuntime[] } | null = null;
  let selecting: Promise<void> | null = null;
  let leases = 0;
  const drained: (() => void)[] = [];
  let generation = 0;
  let failedGpuKey: string | null = null;
  let loadingWorker: Worker | null = null;
  let transcribing = 0;

  const key = () => JSON.stringify(getSettings());
  const release = () => {
    leases--;
    if (!leases) {
      drained.splice(0).forEach(resolve => resolve());
    }
  };
  const ensure = async (pinned?: RuntimePlan): Promise<NonNullable<typeof current>> => {
    if (selecting) await selecting;
    const settings = structuredClone(pinned?.settings ?? getSettings());
    const desiredKey = JSON.stringify(settings);
    if (current?.key === desiredKey && (!pinned?.candidates || pinned.candidates.some(candidate =>
      candidate.backend === current?.runtime.backend && candidate.modelPath === current.runtime.modelPath))) return current;
    if (leases) {
      await new Promise<void>(resolve => drained.push(resolve));
      return ensure(pinned);
    }
    const token = generation;
    selecting = (async () => {
      await current?.worker.shutdown();
      current = null;
      onStatus({ status: 'loading', backend: null, message: 'Starting local speech recognition…' }, settings);
      let failure = '';
      try {
        const candidates = pinned?.candidates ?? await getCandidates(settings.selection);
        for (const runtime of candidates) {
          if (token !== generation) throw new Error('Local speech recognition stopped.');
          if (runtime.backend === 'cuda' && failedGpuKey === desiredKey
            && settings.selection.devices[settings.selection.model] === 'auto') continue;
          const worker = createWorker(settings.contextual ? { ...runtime, contextual: true } : runtime, settings.numThreads);
          loadingWorker = worker;
          try {
            await worker.warmup();
            if (token !== generation) throw new Error('Local speech recognition stopped.');
            current = { key: desiredKey, worker, runtime, settings, candidates };
            onStatus({ status: 'ready', backend: runtime.backend,
              // Only the GPU fallback needs words; the status tag already names the processor.
              message: runtime.backend === 'cpu' && (failure || failedGpuKey === desiredKey)
                ? 'The GPU could not start. Select NVIDIA GPU to retry.' : '' }, settings);
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
    if (!pinned && key() !== desiredKey) return ensure();
    return current;
  };

  const acquire = async (pinned: RuntimePlan) => {
    const selected = await ensure(pinned);
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

  const transcribePinned = async (request: TranscriptionRequest, settings: EngineSettings) => {
    transcribing++;
    const operationGeneration = generation;
    // Cancellation and shutdown end this recording: no fallback worker is started for it afterwards.
    const stopped = () => operationGeneration !== generation || request.signal?.aborted === true;
    try {
      const selected = await acquire({ settings, candidates: null });
      try {
        if (stopped()) throw new TranscriptionFailure('model', 'Local speech recognition stopped.');
        return await selected.worker.transcribe(request);
      }
      catch (error) {
        if (stopped()) throw error;
        await failed(selected);
        selected.release();
        if (selected.runtime.backend !== 'cuda'
          || selected.settings.selection.devices[selected.runtime.model] !== 'auto' || stopped()) throw error;
        const fallback = await acquire({ settings: selected.settings,
          candidates: selected.candidates.filter(candidate => candidate.backend === 'cpu') });
        try {
          if (stopped()) throw error;
          return await fallback.worker.transcribe(request);
        } finally { fallback.release(); }
      } finally { selected.release(); }
    } finally { transcribing--; }
  };

  const engine = {
    isBusy: () => transcribing > 0 || leases > 0,
    async warmup() {
      // Never wait on or replace a worker that is decoding a recording.
      if (transcribing || leases) return;
      await ensure();
    },
    /**
     * Pins the model, device policy, threads and model revision when a recording begins and starts loading
     * them; Settings edits apply to the next recording. Stop decodes the whole recording once.
     */
    forRecording(): Transcriber {
      const settings = structuredClone(getSettings());
      if (!transcribing && !leases) void ensure({ settings, candidates: null }).catch(() => undefined);
      return {
        id: 'managed-local',
        capabilities: { translation: false, automaticLanguageDetection: false,
          dictionaryHints: settings.selection.model === 'parakeet', authentication: 'none', maxDurationSeconds: null },
        transcribe(request) {
          const recognition = structuredClone(request.recognition);
          return transcribePinned({ ...request, recognition }, { ...settings,
            contextual: settings.selection.model === 'parakeet' && recognition.dictionary.length > 0 });
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
  return engine;
}
