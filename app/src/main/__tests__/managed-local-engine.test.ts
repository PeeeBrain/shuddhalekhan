import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import { createManagedLocalEngine, type LocalRuntime } from '../managed-local-engine';
import { createManagedLocalTranscriber } from '../managed-local-runtime';
import { resolveManagedLocalSelection } from '../../shared/managed-local-selection';

class Process extends EventEmitter {
  killed = false;
  readonly received: unknown[] = [];
  constructor(readonly runtime: LocalRuntime, readonly failLoad = false, readonly crashDecode = false) { super(); }
  postMessage(message: unknown) {
    this.received.push(structuredClone(message));
    if (!message || typeof message !== 'object' || !('kind' in message)) return;
    if (message.kind === 'load') queueMicrotask(() => this.emit('message', this.failLoad
      ? { kind: 'load-error', message: 'CUDA initialization failed' } : { kind: 'ready' }));
    if (message.kind === 'transcribe' || message.kind === 'incremental-finish') {
      if (!('requestId' in message)) throw new Error('Missing correlation id');
      this.emit('decode');
      queueMicrotask(() => this.crashDecode ? this.emit('exit', 1) : this.emit('message', {
        kind: 'result', requestId: message.requestId, text: this.runtime.model + ':' + this.runtime.backend,
      }));
    }
  }
  kill() { this.killed = true; this.emit('exit', 0); return true; }
}

const request = { audio: new Uint8Array([1, 2]), recognition: {
  language: 'auto', task: 'transcribe' as const, dictionary: [], removeFillerWords: false,
} };

function rig({ failLoad = false, crashDecode = false, startup }: { failLoad?: boolean; crashDecode?: boolean; startup?: Promise<void> } = {}) {
  const settings = { selection: resolveManagedLocalSelection(undefined), numThreads: 1, revision: 0 };
  const processes: Process[] = [];
  const engine = createManagedLocalEngine({
    getSettings: () => settings,
    getCandidates: async selection => {
      await startup;
      return (selection.devices[selection.model] === 'auto' ? ['cuda', 'cpu'] as const
        : [selection.devices[selection.model] === 'cuda' ? 'cuda' : 'cpu'] as const)
        .map(backend => ({ model: selection.model, backend, modelPath: 'model' }));
    },
    createWorker(runtime, numThreads) {
      return createManagedLocalTranscriber({ getModelPath: async () => runtime.modelPath,
        getNumThreads: () => numThreads, startProcess() {
          const child = new Process(runtime, runtime.backend === 'cuda' && failLoad, runtime.backend === 'cuda' && crashDecode);
          processes.push(child);
          return child;
        } });
    },
    onStatus() {},
  });
  return { engine, settings, processes };
}

describe('local model and device lifecycle', () => {
  it('protects model files as soon as recording startup begins, and releases them when cancelled', async () => {
    let allowStartup!: () => void;
    const startup = new Promise<void>(resolve => { allowStartup = resolve; });
    const { engine } = rig({ startup });
    const recording = engine.startIncremental!(request);
    try {
      expect(engine.isBusy()).toBe(true);
      recording.cancel();
      expect(engine.isBusy()).toBe(false);
    } finally {
      recording.cancel();
      allowStartup();
      await recording.finish().catch(() => {});
      await engine.shutdown();
    }
  });

  it.each(['auto', 'cuda'] as const)('keeps the original %s policy and model through a failed recording retry', async (preference: 'auto' | 'cuda') => {
    const { engine, settings } = rig({ crashDecode: true });
    settings.selection.devices.parakeet = preference;
    const recording = engine.startIncremental!(request);
    try {
      await recording.send(new Uint8Array([1, 2]));
      settings.selection.model = 'granite';
      settings.selection.devices.parakeet = preference === 'auto' ? 'cuda' : 'auto';
      await expect(recording.finish()).rejects.toThrow('stopped unexpectedly');
      expect(engine.isBusy()).toBe(true);
      const retry = recording.retryCompletedAudio!(request.audio);
      if (preference === 'auto') expect(await retry).toBe('parakeet:cpu');
      else await expect(retry).rejects.toThrow();
      expect(engine.isBusy()).toBe(false);
    } finally { recording.cancel(); await engine.shutdown(); }
  });

  it('keeps a stream that failed during recording busy until its completed audio is retried or discarded', async () => {
    const { engine, processes } = rig();
    const recording = engine.startIncremental!(request);
    try {
      await recording.send(new Uint8Array([1, 2]));
      processes[0].emit('exit', 1);
      await expect(recording.send(new Uint8Array([3, 4]))).rejects.toThrow();
      expect(engine.isBusy()).toBe(true);
      recording.cancel();
      expect(engine.isBusy()).toBe(false);
      await expect(recording.retryCompletedAudio!(request.audio)).rejects.toThrow('cancelled');
      expect(processes).toHaveLength(1);
    } finally { recording.cancel(); await engine.shutdown(); }
  });

  it.each(['auto', 'cuda'] as const)('keeps the original %s policy during a batch GPU failure even if Settings changes', async (preference: 'auto' | 'cuda') => {
    const { engine, settings, processes } = rig({ crashDecode: true });
    settings.selection.devices.parakeet = preference;
    try {
      await engine.warmup();
      const decoding = new Promise<void>(resolve => processes[0].once('decode', resolve));
      const text = engine.transcribe(request);
      await decoding;
      settings.selection.model = 'granite';
      settings.selection.devices.parakeet = preference === 'auto' ? 'cuda' : 'auto';
      if (preference === 'auto') expect(await text).toBe('parakeet:cpu');
      else await expect(text).rejects.toThrow();
    } finally { await engine.shutdown(); }
  });
  it('falls back after GPU initialization failure and does not retry the broken GPU every recording', async () => {
    const { engine, processes } = rig({ failLoad: true });
    try {
      expect(await engine.transcribe(request)).toBe('parakeet:cpu');
      expect(await engine.transcribe(request)).toBe('parakeet:cpu');
      expect(processes.map(p => p.runtime.backend)).toEqual(['cuda', 'cpu']);
      expect(processes[0].killed).toBe(true);
    } finally { await engine.shutdown(); }
  });

  it('reports GPU initialization failure without silently using CPU in dedicated GPU mode', async () => {
    const { engine, settings, processes } = rig({ failLoad: true });
    settings.selection.devices.parakeet = 'cuda';
    try {
      await expect(engine.transcribe(request)).rejects.toThrow('could not load');
      expect(processes).toHaveLength(1);
      expect(processes[0].killed).toBe(true);
    } finally { await engine.shutdown(); }
  });

  it('retries completed audio on CPU after a GPU worker crash in Auto', async () => {
    const { engine, processes } = rig({ crashDecode: true });
    try {
      expect(await engine.transcribe({ ...request, recognition: { ...request.recognition, dictionary: ['Shuddhalekhan'] } })).toBe('parakeet:cpu');
      expect(processes.map(p => p.runtime.backend)).toEqual(['cuda', 'cpu']);
      for (const process of processes) {
        expect(process.received).toContainEqual(expect.objectContaining({ kind: 'transcribe', dictionary: ['Shuddhalekhan'] }));
      }
    } finally { await engine.shutdown(); }
  });

  it('keeps the recording on its original model while a new selection waits for finish', async () => {
    const { engine, settings, processes } = rig();
    settings.selection.devices.parakeet = 'cpu';
    settings.selection.devices.granite = 'cpu';
    try {
      const recording = engine.startIncremental!(request);
      await recording.send(new Uint8Array([1, 2]));
      settings.selection.model = 'granite';
      await engine.warmup();
      expect(processes[0].killed).toBe(false);
      const next = engine.transcribe(request);
      expect(await recording.finish()).toBe('parakeet:cpu');
      expect(await next).toBe('granite:cpu');
      expect(processes[0].killed).toBe(true);
      expect(processes).toHaveLength(2);
    } finally { await engine.shutdown(); }
  });
});
