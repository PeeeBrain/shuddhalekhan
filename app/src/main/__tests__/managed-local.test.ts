import { afterAll, describe, expect, it, mock } from 'bun:test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LOCAL_MODELS, LOCAL_FORMATTING_MODEL } from '../managed-local-catalog';
import type { ManagedLocalModelManifest } from '../managed-local-model';

mock.module('../config', () => ({ getConfig: () => ({ dictionary: [] }) }));
// Main's orchestration tests initialize their own registry; this fixture owns a separate model root.
const { configureManagedLocal, deleteManagedLocalModel, getManagedLocalModelManager } = await import(`../managed-local?test=${Date.now()}`);

const root = await mkdtemp(join(tmpdir(), 'shuddhalekhan-managed-local-'));
afterAll(() => rm(root, { recursive: true, force: true }));

const directory = (part: ManagedLocalModelManifest) => join(root, `${part.id}-${part.version}`);
const installed = (part: ManagedLocalModelManifest) => access(directory(part)).then(() => true, () => false);
const [parakeet, granite] = LOCAL_MODELS;

describe('Managed Local GPU setup', () => {
  it('deletes only GPU parts nothing else still uses', async () => {
    for (const part of new Set([parakeet.cpu, granite.cpu, ...parakeet.cuda, ...granite.cuda])) {
      await mkdir(directory(part), { recursive: true });
      for (const file of part.requiredFiles) await writeFile(join(directory(part), file), '');
    }
    configureManagedLocal({ root, onStateChanged: () => {} });
    const cpu = getManagedLocalModelManager({ model: 'parakeet', backend: 'cpu' });
    expect((await cpu.getState()).kind).toBe('ready');
    expect((await cpu.getInstallState()).kind).toBe('missing');
    await mkdir(directory(LOCAL_FORMATTING_MODEL), { recursive: true });
    for (const file of LOCAL_FORMATTING_MODEL.requiredFiles) await writeFile(join(directory(LOCAL_FORMATTING_MODEL), file), '');
    const state = async (model: 'parakeet' | 'granite') => (await getManagedLocalModelManager({ model, backend: 'cuda' }).getState()).kind;
    expect(await state('parakeet')).toBe('ready');

    await deleteManagedLocalModel({ model: 'parakeet', backend: 'cuda' });
    expect(await state('parakeet')).toBe('missing');
    expect(await state('granite')).toBe('ready');
    expect(await installed(parakeet.cpu)).toBe(true);
    expect(await installed(LOCAL_FORMATTING_MODEL)).toBe(true);
    expect(await installed(parakeet.cuda[0])).toBe(false);

    await deleteManagedLocalModel({ model: 'granite', backend: 'cuda' });
    expect(await installed(granite.cpu)).toBe(true);
    expect((await Promise.all(granite.cuda.slice(1).map(installed))).includes(true)).toBe(false);
    await deleteManagedLocalModel({ model: 'granite', backend: 'cpu' });
    expect(await installed(granite.cpu)).toBe(false);
    expect(await installed(LOCAL_FORMATTING_MODEL)).toBe(true);
    await deleteManagedLocalModel({ model: 'parakeet', backend: 'cpu' });
    expect(await installed(LOCAL_FORMATTING_MODEL)).toBe(false);
  });
});
