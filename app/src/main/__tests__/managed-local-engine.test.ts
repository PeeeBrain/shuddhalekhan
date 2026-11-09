import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import { createManagedLocalEngine, type LocalRuntime } from '../managed-local-engine';
import { createManagedLocalTranscriber } from '../managed-local-runtime';
import { resolveManagedLocalSelection } from '../../shared/managed-local-selection';

class Process extends EventEmitter {
  killed = false;
  readonly received: unknown[] = [];
  constructor(readonly runtime: LocalRuntime, readonly numThreads: number, readonly failLoad = false, readonly crashDecode = false) { super(); }
  postMessage(message: unknown) {
    this.received.push(structuredClone(message));
    if (!message || typeof message !== 'object' || !('kind' in message)) return;
    if (message.kind === 'load') queueMicrotask(() => this.emit('message', this.failLoad
      ? { kind: 'load-error', message: 'CUDA initialization failed' } : { kind: 'ready' }));
    if (message.kind === 'transcribe') {
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
  const settings = { selection: resolveManagedLocalSelection(undefined), numThreads: 1, revision: 0, contextual: false };
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
        numThreads, startProcess() {
          const child = new Process(runtime, numThreads, runtime.backend === 'cuda' && failLoad, runtime.backend === 'cuda' && crashDecode);
          processes.push(child);
          return child;
        } });
    },
    onStatus() {},
  });
  return { engine, settings, processes };
}

describe('Managed Local recording decode', () => {
  it('decodes with the model, device and threads the recording began with, and reuses the warm worker', async () => {
    const { engine, settings, processes } = rig();
    settings.selection.devices.parakeet = 'cpu';
    settings.selection.devices.granite = 'cpu';
    try {
      const recording = engine.forRecording();
      settings.selection.model = 'granite';
      settings.numThreads = 2;
      expect(await recording.transcribe(request)).toBe('parakeet:cpu');
      expect(await engine.forRecording().transcribe(request)).toBe('granite:cpu');
      expect(await engine.forRecording().transcribe(request)).toBe('granite:cpu');
      expect(processes.map(p => [p.runtime.model, p.numThreads])).toEqual([['parakeet', 1], ['granite', 2]]);
    } finally { await engine.shutdown(); }
  });

  it.each(['auto', 'cuda'] as const)('keeps the original %s policy during a GPU decode failure even if Settings changes', async (preference: 'auto' | 'cuda') => {
    const { engine, settings, processes } = rig({ crashDecode: true });
    settings.selection.devices.parakeet = preference;
    try {
      const recording = engine.forRecording();
      const decoding = new Promise<void>(resolve => engine.warmup().then(() => processes[0].once('decode', resolve)));
      const text = recording.transcribe(request);
      await decoding;
      settings.selection.model = 'granite';
      settings.selection.devices.parakeet = preference === 'auto' ? 'cuda' : 'auto';
      if (preference === 'auto') expect(await text).toBe('parakeet:cpu');
      else await expect(text).rejects.toThrow();
      expect(engine.isBusy()).toBe(false);
    } finally { await engine.shutdown(); }
  });

  it('falls back after GPU initialization failure and does not retry the broken GPU every recording', async () => {
    const { engine, processes } = rig({ failLoad: true });
    try {
      expect(await engine.forRecording().transcribe(request)).toBe('parakeet:cpu');
      expect(await engine.forRecording().transcribe(request)).toBe('parakeet:cpu');
      expect(processes.map(p => p.runtime.backend)).toEqual(['cuda', 'cpu']);
      expect(processes[0].killed).toBe(true);
    } finally { await engine.shutdown(); }
  });

  it('reports GPU initialization failure without silently using CPU in dedicated GPU mode', async () => {
    const { engine, settings, processes } = rig({ failLoad: true });
    settings.selection.devices.parakeet = 'cuda';
    try {
      await expect(engine.forRecording().transcribe(request)).rejects.toThrow('could not load');
      expect(processes).toHaveLength(1);
      expect(processes[0].killed).toBe(true);
    } finally { await engine.shutdown(); }
  });

  it('retries the recording on CPU with its pinned vocabulary after a GPU worker crash in Auto', async () => {
    let allowStartup!: () => void;
    const startup = new Promise<void>(resolve => { allowStartup = resolve; });
    const { engine, processes } = rig({ crashDecode: true, startup });
    const dictionary = ['Shuddhalekhan'];
    try {
      const text = engine.forRecording().transcribe({ ...request, recognition: { ...request.recognition, dictionary } });
      dictionary.length = 0;
      allowStartup();
      expect(await text).toBe('parakeet:cpu');
      expect(processes.map(p => p.runtime.backend)).toEqual(['cuda', 'cuda', 'cpu']);
      for (const process of processes.slice(1)) {
        expect(process.runtime.contextual).toBe(true);
        expect(process.received).toContainEqual(expect.objectContaining({ kind: 'transcribe', dictionary: ['Shuddhalekhan'] }));
      }
    } finally { await engine.shutdown(); }
  });

  it('starts no CPU retry when the recording is cancelled during GPU inference', async () => {
    const { engine, processes } = rig({ crashDecode: true });
    try {
      const recording = engine.forRecording();
      await engine.warmup();
      const abort = new AbortController();
      processes[0].once('decode', () => abort.abort());
      await expect(recording.transcribe({ ...request, signal: abort.signal })).rejects.toThrow();
      await Promise.resolve();
      expect(processes.map(p => p.runtime.backend)).toEqual(['cuda']);
      expect(engine.isBusy()).toBe(false);
    } finally { await engine.shutdown(); }
  });
});
