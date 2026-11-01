// Explicit native integration check; not part of default bun test. Run the bundled script with Electron.
import { app } from 'electron';
import { parseArgs } from 'util';
import { readFile, writeFile, copyFile, mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import { createManagedLocalModelManager } from '../src/main/managed-local-model';
import { LOCAL_MODELS } from '../src/main/managed-local-catalog';
import { createManagedLocalTranscriber } from '../src/main/managed-local-runtime';
import { startLocalRuntimeProcess } from '../src/main/managed-local-process';
import { decodePcm16Wave } from '../src/main/managed-local-wave';
import type { LocalRuntime } from '../src/main/managed-local-engine';

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  bundles: { type: 'string' }, root: { type: 'string' }, 'parakeet-cpu': { type: 'string' },
  'granite-gguf': { type: 'string' }, audio: { type: 'string' }, out: { type: 'string' },
} });
if (!values.root || !values.bundles || !values['parakeet-cpu'] || !values['granite-gguf'] || !values.audio || !values.out) {
  throw new Error('Provide --root --bundles --parakeet-cpu --granite-gguf --audio --out.');
}
const root = resolve(values.root);
const bundles = resolve(values.bundles);
const gguf = resolve(values['granite-gguf']);
const cpuPath = resolve(values['parakeet-cpu']);
const audioPath = resolve(values.audio);
const outputPath = resolve(values.out);
const workers: ReturnType<typeof createManagedLocalTranscriber>[] = [];

void app.whenReady().then(async () => {
  const results = [];
  try {
    const bytes = await readFile(audioPath);
    const audio = new Uint8Array(bytes);
    const wave = decodePcm16Wave(audio.buffer);
    const pcm = new Uint8Array(wave.samples.length * 2);
    const pcmView = new DataView(pcm.buffer);
    for (let i = 0; i < wave.samples.length; i++) pcmView.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(wave.samples[i] * 32768))), true);
    await mkdir(root, { recursive: true });
    for (const model of LOCAL_MODELS) {
      for (const backend of ['cpu', 'cuda'] as const) {
        let modelPath = cpuPath;
        if (model.key !== 'parakeet' || backend !== 'cpu') {
          const manifest = model[backend];
          const manager = createManagedLocalModelManager({ root, manifest });
          const installed = await manager.getState();
          if (installed.kind !== 'ready') {
            const source = backend === 'cpu' ? gguf : join(bundles, `${manifest.id}-${manifest.version}.tar.bz2`);
            await copyFile(source, join(root, `${manifest.id}-${manifest.version}.partial`));
            await manager.install();
          }
          const state = await manager.getState();
          if (state.kind !== 'ready') throw new Error('Verified installation did not become ready.');
          modelPath = state.path;
        }
        const runtime: LocalRuntime = { model: model.key, backend, modelPath,
          ...(backend === 'cuda' ? { runtimePath: join(modelPath, 'runtime') } : {}) };
        const worker = createManagedLocalTranscriber({ getModelPath: async () => modelPath, runtime,
          getNumThreads: () => 10, startProcess: () => startLocalRuntimeProcess(runtime) });
        workers.push(worker);
        const request = { audio, recognition: { language: 'en', task: 'transcribe' as const, dictionary: [], removeFillerWords: false } };
        await worker.warmup();
        const text = await worker.transcribe(request);
        if (!text.trim()) throw new Error(`${model.key}/${backend} returned an empty transcript.`);
        const recording = worker.startIncremental(request);
        for (let offset = 0; offset < pcm.length; offset += 1280) await recording.send(pcm.slice(offset, offset + 1280));
        const incremental = await recording.finish();
        if (!incremental.trim()) throw new Error(`${model.key}/${backend} returned an empty incremental transcript.`);
        results.push({ model: model.key, backend, text, incremental, verified: true });
        await worker.shutdown();
      }
    }
    await writeFile(outputPath, JSON.stringify({ audioPath, entryPath: process.argv[1], electronVersion: process.versions.electron, results }, null, 2));
    console.log(JSON.stringify(results));
    app.exit(0);
  } catch (error) {
    console.error(error);
    await Promise.all(workers.map(worker => worker.shutdown()));
    app.exit(1);
  }
});
