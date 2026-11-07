// Explicit native integration check; not part of default bun test. Run the bundled script with Electron.
import { app } from 'electron';
import { parseArgs } from 'util';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { createManagedLocalModelManager } from '../src/main/managed-local-model';
import { LOCAL_MODELS, LOCAL_FORMATTING_MODEL } from '../src/main/managed-local-catalog';
import { createManagedLocalTranscriber } from '../src/main/managed-local-runtime';
import { startLocalRuntimeProcess } from '../src/main/managed-local-process';
import type { LocalRuntime } from '../src/main/managed-local-engine';

// Downloads every pinned upstream part into --root (reused across runs), then transcribes on each model/backend.
const { values } = parseArgs({ args: process.argv.slice(2), options: {
  root: { type: 'string' }, audio: { type: 'string' }, out: { type: 'string' },
} });
if (!values.root || !values.audio || !values.out) throw new Error('Provide --root --audio --out.');
const root = resolve(values.root);
const audioPath = resolve(values.audio);
const outputPath = resolve(values.out);
const workers: ReturnType<typeof createManagedLocalTranscriber>[] = [];

void app.whenReady().then(async () => {
  const results = [];
  try {
    const bytes = await readFile(audioPath);
    const audio = new Uint8Array(bytes);
    for (const model of LOCAL_MODELS) {
      for (const backend of ['cpu', 'cuda'] as const) {
        const paths: string[] = [];
        for (const manifest of [...(backend === 'cpu' ? [model.cpu] : model.cuda), LOCAL_FORMATTING_MODEL]) {
          const manager = createManagedLocalModelManager({ root, manifest });
          if ((await manager.getState()).kind !== 'ready') await manager.install();
          const state = await manager.getState();
          if (state.kind !== 'ready') throw new Error(`${manifest.id} did not become ready.`);
          paths.push(state.path);
        }
        const formattingPath = paths.pop();
        const [modelPath, ...libraryPaths] = paths;
        const runtime: LocalRuntime = { model: model.key, backend, modelPath, formattingPath,
          ...(backend === 'cuda' ? { libraryPaths } : {}) };
        const worker = createManagedLocalTranscriber({ getModelPath: async () => modelPath, runtime,
          getNumThreads: () => 10, startProcess: () => startLocalRuntimeProcess(runtime) });
        workers.push(worker);
        const request = { audio, recognition: { language: 'en', task: 'transcribe' as const, dictionary: [], removeFillerWords: false } };
        await worker.warmup();
        const text = await worker.transcribe(request);
        if (!text.trim()) throw new Error(`${model.key}/${backend} returned an empty transcript.`);
        results.push({ model: model.key, backend, text, verified: true });
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
