import { execFile } from 'child_process';
import { z } from 'zod';
import { TranscriptionFailure } from './transcription';
import { createManagedLocalModelManager, type ManagedLocalModelManifest } from './managed-local-model';
import { createManagedLocalTranscriber } from './managed-local-runtime';
import { createManagedLocalEngine, type LocalRuntime } from './managed-local-engine';
import { startLocalRuntimeProcess } from './managed-local-process';
import { LOCAL_MODELS, legacyLocalModel } from './managed-local-catalog';
import type { ManagedLocalModelSnapshot, ManagedLocalModelState, ManagedLocalTarget } from '../types/ipc';
import { resolveManagedLocalSelection } from '../shared/managed-local-selection';
import { getConfig } from './config';
import { getManagedLocalThreadLimits, resolveManagedLocalThreads } from './managed-local-threads';

type ModelManager = ReturnType<typeof createManagedLocalModelManager>;
/** What Settings installs and deletes for one model/backend. CPU is one part; GPU is several upstream parts. */
type Target = Pick<ModelManager, 'getState' | 'getInstallState' | 'getLegacy' | 'install' | 'delete' | 'deleteLegacy'> & {
  manifest: Pick<ManagedLocalModelManifest, 'id' | 'name' | 'languages' | 'downloadBytes' | 'installedBytes'>;
  parts: ModelManager[];
};

const targets = new Map<string, Target>();
const cpuParts = new Set<ModelManager>();
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
let revision = 0;
let publish: (state: ManagedLocalModelState) => void = () => {};
let runtimeStatus: ManagedLocalModelSnapshot['runtime'] = { status: 'idle', backend: null, message: '' };
let runtimeSettings = '';
const selection = () => resolveManagedLocalSelection(getConfig().managedLocal);
const selectionKey = () => JSON.stringify({ selection: selection(), numThreads: resolveManagedLocalThreads(getConfig().managedLocalThreads) });

export const managedLocalTranscriber = createManagedLocalEngine({
  getSettings: () => ({ selection: selection(), numThreads: resolveManagedLocalThreads(getConfig().managedLocalThreads), revision }),
  async getCandidates(settings) {
    const preference = settings.devices[settings.model];
    const candidates: LocalRuntime[] = [];
    if (preference !== 'cpu') {
      const parts = await Promise.all(getManagedLocalModelManager({ model: settings.model, backend: 'cuda' }).parts
        .map(async part => { const state = await part.getInstallState(); return state.kind === 'ready' ? state.path : null; }));
      const [modelPath, ...libraryPaths] = parts;
      if (modelPath && libraryPaths.every(path => path !== null)) {
        candidates.push({ model: settings.model, backend: 'cuda', modelPath, libraryPaths });
      } else if (preference === 'cuda') throw new TranscriptionFailure('model', 'Set up GPU acceleration files for the selected model in Settings, or choose CPU.');
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
  if (targets.size) return;
  publish = onStateChanged;
  // Parts are shared by id, so CUDA libraries download once and Granite GPU reuses the CPU model file.
  const parts = new Map<string, ModelManager>();
  const part = (manifest: ManagedLocalModelManifest, legacy?: ReturnType<typeof legacyLocalModel>) => {
    const key = `${manifest.id}-${manifest.version}`;
    let manager = parts.get(key);
    if (!manager) parts.set(key, manager = createManagedLocalModelManager({ root, manifest, legacy, onStateChanged }));
    return manager;
  };
  for (const model of LOCAL_MODELS) {
    const cpu = part(model.cpu, legacyLocalModel(model.key));
    cpuParts.add(cpu);
    targets.set(`${model.key}:cpu`, { ...cpu, parts: [cpu] });
  }
  for (const model of LOCAL_MODELS) {
    targets.set(`${model.key}:cuda`, gpuTarget(`${model.key}-cuda`, `${model.name} GPU`, model.languages, model.cuda.map(item => part(item))));
  }
}

function gpuTarget(id: string, name: string, languages: string[], parts: ModelManager[]): Target {
  let pending: ModelManager[] | null = null;
  let active: Promise<void> | null = null;
  const getInstallState = async (): Promise<ManagedLocalModelState> => {
    const states = await Promise.all(parts.map(part => part.getInstallState()));
    const error = states.find(state => state.kind === 'error');
    if (error) return { ...error, modelId: id };
    if (states.every(state => state.kind === 'ready') && states[0].kind === 'ready') return { kind: 'ready', modelId: id, path: states[0].path };
    if (!pending) return { kind: 'missing', modelId: id };
    if (states.some(state => state.kind === 'installing')) return { kind: 'installing', modelId: id };
    // One progress bar across the parts this install started with.
    const progress = pending.map(part => {
      const state = states[parts.indexOf(part)];
      return state.kind === 'ready' ? part.manifest.downloadBytes : state.kind === 'downloading' ? state.downloadedBytes : 0;
    });
    return { kind: 'downloading', modelId: id, downloadedBytes: sum(progress), totalBytes: sum(pending.map(part => part.manifest.downloadBytes)) };
  };
  const target: Target = {
    manifest: { id, name, languages, downloadBytes: sum(parts.map(part => part.manifest.downloadBytes)),
      installedBytes: sum(parts.filter(part => !cpuParts.has(part)).map(part => part.manifest.installedBytes)) },
    parts,
    getInstallState,
    getState: getInstallState,
    getLegacy: async () => null,
    deleteLegacy: async () => {},
    install() {
      return active ??= (async () => {
        const states = await Promise.all(parts.map(part => part.getInstallState()));
        pending = parts.filter((_, index) => states[index].kind !== 'ready');
        for (const part of pending) await part.install();
      })().finally(() => { active = null; pending = null; });
    },
    async delete() {
      if (active) throw new Error('Wait for the model installation to finish before deleting it.');
      // Keep CPU model files and libraries another installed GPU setup still uses.
      for (const part of parts) {
        if (cpuParts.has(part)) continue;
        const others = [...targets.values()].filter(other => other !== target && other.parts.includes(part));
        const used = await Promise.all(others.map(async other => (await other.getInstallState()).kind === 'ready'));
        if (!used.includes(true)) await part.delete();
      }
    },
  };
  return target;
}

const targetSchema = z.object({ model: z.enum(['parakeet', 'granite']), backend: z.enum(['cpu', 'cuda']) });
export function managedLocalTarget(value?: unknown): ManagedLocalTarget {
  if (value !== undefined) return targetSchema.parse(value);
  const settings = selection();
  return { model: settings.model, backend: settings.devices[settings.model] === 'cuda' ? 'cuda' : 'cpu' };
}

export function getManagedLocalModelManager(target = managedLocalTarget()): Target {
  const manager = targets.get(`${target.model}:${target.backend}`);
  if (!manager) throw new Error('Managed Local is not initialized.');
  return manager;
}

export async function managedLocalSnapshot(): Promise<ManagedLocalModelSnapshot> {
  const selected = getManagedLocalModelManager();
  const catalog = await Promise.all(LOCAL_MODELS.map(async model => {
    const variant = async (backend: 'cpu' | 'cuda') => {
      const manager = getManagedLocalModelManager({ model: model.key, backend });
      const [state, legacy] = await Promise.all([manager.getInstallState(), manager.getLegacy()]);
      // A GPU setup only downloads the parts that are not installed yet.
      const missing = await Promise.all(manager.parts.map(async part =>
        (await part.getInstallState()).kind === 'ready' ? 0 : part.manifest.downloadBytes));
      return { downloadBytes: backend === 'cpu' ? manager.manifest.downloadBytes : sum(missing),
        installedBytes: manager.manifest.installedBytes, state,
        legacy: legacy && { name: legacy.name, installedBytes: legacy.installedBytes, inUse: state.kind !== 'ready' } };
    };
    return { key: model.key, name: model.name, description: model.description, languages: [...model.languages],
      cpu: await variant('cpu'), cuda: await variant('cuda') };
  }));
  // Primary state is what the next recording can use, so upgraded installs stay ready on their previous files.
  const state = await selected.getState();
  const legacy = state.kind === 'ready' && state.modelId !== selected.manifest.id ? await selected.getLegacy() : null;
  const model = legacy ?? selected.manifest;
  return {
    model: { id: model.id, name: model.name, languages: [...model.languages],
      downloadBytes: model.downloadBytes, installedBytes: model.installedBytes },
    state, inference: getManagedLocalThreadLimits(), catalog,
    runtime: runtimeSettings === selectionKey() ? runtimeStatus
      : { status: 'idle', backend: null, message: '' },
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
  const legacy = z.object({ legacy: z.literal(true).optional() }).parse(value ?? {}).legacy;
  await managedLocalTranscriber.shutdown();
  const manager = getManagedLocalModelManager(target);
  await (legacy ? manager.deleteLegacy() : manager.delete());
  revision++;
  return managedLocalSnapshot();
}

let gpu: Promise<ManagedLocalModelSnapshot['gpu']> | null = null;
function gpuInfo(): Promise<ManagedLocalModelSnapshot['gpu']> {
  return gpu ??= new Promise(resolve => {
    execFile('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      const name = !error ? stdout.trim().split(/\r?\n/)[0] : null;
      resolve({ name, message: name ? '' : 'No NVIDIA GPU detected.' });
    });
  });
}
