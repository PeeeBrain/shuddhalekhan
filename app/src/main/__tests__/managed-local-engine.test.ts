import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import { createManagedLocalEngine, type LocalRuntime } from '../managed-local-engine';
import { createManagedLocalTranscriber } from '../managed-local-runtime';
import { resolveManagedLocalSelection } from '../../shared/managed-local-selection';

class Process extends EventEmitter {
  killed = false;
  constructor(readonly runtime: LocalRuntime, readonly failLoad = false, readonly crashDecode = false) { super(); }
  postMessage(message: unknown) {
    if (!message || typeof message !== 'object' || !('kind' in message)) return;
    if (message.kind === 'load') queueMicrotask(() => this.emit('message', this.failLoad
      ? { kind: 'load-error', message: 'CUDA initialization failed' } : { kind: 'ready' }));
    if (message.kind === 'transcribe' || message.kind === 'incremental-finish') {
      if (!('requestId' in message)) throw new Error('Missing correlation id');
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

function rig({ failLoad = false, crashDecode = false } = {}) {
  const settings = { selection: resolveManagedLocalSelection(undefined), numThreads: 1, revision: 0 };
  const processes: Process[] = [];
  const engine = createManagedLocalEngine({
    getSettings: () => settings,
    getCandidates: async selection => (selection.devices[selection.model] === 'auto' ? ['cuda', 'cpu'] as const
      : [selection.devices[selection.model] === 'cuda' ? 'cuda' : 'cpu'] as const)
      .map(backend => ({ model: selection.model, backend, modelPath: 'model' })),
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
      expect(await engine.transcribe(request)).toBe('parakeet:cpu');
      expect(processes.map(p => p.runtime.backend)).toEqual(['cuda', 'cpu']);
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
