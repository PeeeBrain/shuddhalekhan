import { execFile } from 'child_process';
import { join } from 'path';
import { z } from 'zod';
import { TranscriptionFailure } from './transcription';
import { createManagedLocalModelManager } from './managed-local-model';
import { createManagedLocalTranscriber } from './managed-local-runtime';
import { createManagedLocalEngine, type LocalRuntime } from './managed-local-engine';
import { startLocalRuntimeProcess } from './managed-local-process';
import { LOCAL_MODELS, localModelManifest } from './managed-local-catalog';
import type { ManagedLocalModelSnapshot, ManagedLocalModelState, ManagedLocalTarget } from '../types/ipc';
import { resolveManagedLocalSelection } from '../shared/managed-local-selection';
import { getConfig } from './config';
import { getManagedLocalThreadLimits, resolveManagedLocalThreads } from './managed-local-threads';

type ModelManager = ReturnType<typeof createManagedLocalModelManager>;

const managers = new Map<string, ModelManager>();
let revision = 0;
let publish: (state: ManagedLocalModelState) => void = () => {};
let runtimeStatus: ManagedLocalModelSnapshot['runtime'] = { status: 'idle', backend: null, message: 'Starts with the next recording.' };
let runtimeSettings = '';
const selection = () => resolveManagedLocalSelection(getConfig().managedLocal);
const selectionKey = () => JSON.stringify({ selection: selection(), numThreads: resolveManagedLocalThreads(getConfig().managedLocalThreads) });

export const managedLocalTranscriber = createManagedLocalEngine({
  getSettings: () => ({ selection: selection(), numThreads: resolveManagedLocalThreads(getConfig().managedLocalThreads), revision }),
  async getCandidates(settings) {
    const preference = settings.devices[settings.model];
    const candidates: LocalRuntime[] = [];
    if (preference !== 'cpu') {
      const gpu = await getManagedLocalModelManager({ model: settings.model, backend: 'cuda' }).getState();
      if (gpu.kind === 'ready') candidates.push({ model: settings.model, backend: 'cuda', modelPath: gpu.path, runtimePath: join(gpu.path, 'runtime') });
      else if (preference === 'cuda') throw new TranscriptionFailure('model', 'Set up GPU acceleration files for the selected model in Settings, or choose CPU.');
    }
    if (preference !== 'cuda') {
      const cpu = await getManagedLocalModelManager({ model: settings.model, backend: 'cpu' }).getState();
      if (cpu.kind !== 'ready') throw new TranscriptionFailure('model', 'Install CPU files for the selected model in Settings. Auto needs them for fallback.');
      candidates.push({ model: settings.model, backend: 'cpu', modelPath: cpu.path });
    }
    return candidates;
  },
  createWorker: (runtime, numThreads) => createManagedLocalTranscriber({
    getModelPath: async () => runtime.modelPath, getNumThreads: () => numThreads, runtime,
    startProcess: () => startLocalRuntimeProcess(runtime),
  }),
  onStatus(status, settings) {
    runtimeStatus = status;
    runtimeSettings = JSON.stringify({ selection: settings.selection, numThreads: settings.numThreads });
    void getManagedLocalModelManager().getState().then(publish).catch(() => {});
  },
});

export function configureManagedLocal({
  root,
  onStateChanged,
}: {
  root: string;
  onStateChanged: (state: ManagedLocalModelState) => void;
}): void {
  if (managers.size) return;
  publish = onStateChanged;
  for (const model of LOCAL_MODELS) {
    for (const backend of ['cpu', 'cuda'] as const) {
      const target = { model: model.key, backend };
      managers.set(`${model.key}:${backend}`, createManagedLocalModelManager({ root,
        manifest: localModelManifest(target), onStateChanged }));
    }
  }
}

const targetSchema = z.object({ model: z.enum(['parakeet', 'granite']), backend: z.enum(['cpu', 'cuda']) });
export function managedLocalTarget(value?: unknown): ManagedLocalTarget {
  if (value !== undefined) return targetSchema.parse(value);
  const settings = selection();
  return { model: settings.model, backend: settings.devices[settings.model] === 'cuda' ? 'cuda' : 'cpu' };
}

export function getManagedLocalModelManager(target = managedLocalTarget()): ModelManager {
  const manager = managers.get(`${target.model}:${target.backend}`);
  if (!manager) throw new Error('Managed Local is not initialized.');
  return manager;
}

export async function managedLocalSnapshot(): Promise<ManagedLocalModelSnapshot> {
  const selected = getManagedLocalModelManager();
  const catalog = await Promise.all(LOCAL_MODELS.map(async model => {
    const variant = async (backend: 'cpu' | 'cuda') => {
      const manager = getManagedLocalModelManager({ model: model.key, backend });
      return { downloadBytes: manager.manifest.downloadBytes, installedBytes: manager.manifest.installedBytes, state: await manager.getState() };
    };
    return { key: model.key, name: model.name, description: model.description, languages: [...model.languages],
      cpu: await variant('cpu'), cuda: await variant('cuda') };
  }));
  return {
    model: { id: selected.manifest.id, name: selected.manifest.name, languages: [...selected.manifest.languages],
      downloadBytes: selected.manifest.downloadBytes, installedBytes: selected.manifest.installedBytes },
    state: await selected.getState(), inference: getManagedLocalThreadLimits(), catalog,
    runtime: runtimeSettings === selectionKey() ? runtimeStatus
      : { status: 'idle', backend: null, message: 'Changes apply to the next recording.' },
    gpu: await gpuInfo(),
  };
}

export async function installManagedLocalModel(value?: unknown): Promise<ManagedLocalModelSnapshot> {
  const target = managedLocalTarget(value);
  await getManagedLocalModelManager(target).install();
  revision++;
  const settings = selection();
  const device = settings.devices[target.model];
  const cpuReady = (await getManagedLocalModelManager({ model: target.model, backend: 'cpu' }).getState()).kind === 'ready';
  if (!managedLocalTranscriber.isBusy() && settings.model === target.model
    && (device === target.backend || device === 'auto' && cpuReady)) {
    await managedLocalTranscriber.warmup();
  }
  return managedLocalSnapshot();
}

export async function deleteManagedLocalModel(value?: unknown): Promise<ManagedLocalModelSnapshot> {
  if (managedLocalTranscriber.isBusy()) throw new Error('Finish the current recording before deleting local model files.');
  const target = managedLocalTarget(value);
  await managedLocalTranscriber.shutdown();
  await getManagedLocalModelManager(target).delete();
  revision++;
  return managedLocalSnapshot();
}

let gpu: Promise<ManagedLocalModelSnapshot['gpu']> | null = null;
function gpuInfo(): Promise<ManagedLocalModelSnapshot['gpu']> {
  return gpu ??= new Promise(resolve => {
    execFile('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      const name = !error ? stdout.trim().split(/\r?\n/)[0] : null;
      resolve({ name, message: name ? 'GPU setup is verified when the model starts.'
        : 'Dedicated GPU currently requires NVIDIA CUDA. CPU works on other hardware; GPU setup verifies runtime support.' });
    });
  });
}
