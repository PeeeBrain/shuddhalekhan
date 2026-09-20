import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createManagedLocalModelManager,
  validateArchiveEntries,
  type ManagedLocalModelManifest,
} from '../managed-local-model';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'shuddhalekhan-model-'));
  roots.push(root);
  return root;
}

function manifestFor(bytes: Uint8Array): ManagedLocalModelManifest {
  return {
    id: 'test-model',
    version: '1',
    name: 'Test model',
    downloadBytes: bytes.byteLength,
    installedBytes: 4,
    languages: ['English'],
    artifactUrl: 'https://models.example/test.tar.bz2',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    archiveRoot: 'test-model',
    requiredFiles: ['tokens.txt'],
  };
}

describe('managed local model lifecycle', () => {
  it('verifies and atomically promotes a complete download', async () => {
    const root = await tempRoot();
    const archive = new TextEncoder().encode('archive');
    const manifest = manifestFor(archive);
    const manager = createManagedLocalModelManager({
      root,
      manifest,
      fetchArtifact: async () => new Response(archive, { status: 200 }),
      extractArchive: async (_archivePath, stagingPath) => {
        const extracted = join(stagingPath, manifest.archiveRoot);
        await mkdir(extracted, { recursive: true });
        await writeFile(join(extracted, 'tokens.txt'), 'test');
      },
    });

    await manager.install();

    expect(await manager.getState()).toMatchObject({ kind: 'ready', modelId: 'test-model' });
    expect(await readFile(join(root, 'test-model-1', 'tokens.txt'), 'utf8')).toBe('test');
  });

  it('rejects archive entries that could escape the staging directory', () => {
    expect(() => validateArchiveEntries(['model/tokens.txt', '../outside'])).toThrow('unsafe');
    expect(() => validateArchiveEntries(['model/tokens.txt', '/absolute'])).toThrow('unsafe');
    expect(() => validateArchiveEntries(['model/tokens.txt'])).not.toThrow();
  });

  it('resumes a partial download with an HTTP range request', async () => {
    const root = await tempRoot();
    const archive = new TextEncoder().encode('archive');
    const manifest = manifestFor(archive);
    await writeFile(join(root, 'test-model-1.partial'), archive.slice(0, 3));
    let range = '';
    const manager = createManagedLocalModelManager({
      root,
      manifest,
      fetchArtifact: async (_url, init) => {
        range = new Headers(init.headers).get('Range') ?? '';
        return new Response(archive.slice(3), { status: 206 });
      },
      extractArchive: async (_archivePath, stagingPath) => {
        const extracted = join(stagingPath, manifest.archiveRoot);
        await mkdir(extracted, { recursive: true });
        await writeFile(join(extracted, 'tokens.txt'), 'test');
      },
    });

    await manager.install();

    expect(range).toBe('bytes=3-');
    expect((await manager.getState()).kind).toBe('ready');
  });

  it('removes a corrupt download and offers retry', async () => {
    const root = await tempRoot();
    const expected = new TextEncoder().encode('expected');
    const manager = createManagedLocalModelManager({
      root,
      manifest: manifestFor(expected),
      fetchArtifact: async () => new Response('corrupt', { status: 200 }),
    });

    await expect(manager.install()).rejects.toThrow('integrity');

    expect(await manager.getState()).toMatchObject({ kind: 'error', action: 'retry' });
  });

  it('cleans interrupted extraction state and deletes an installed model', async () => {
    const root = await tempRoot();
    const archive = new TextEncoder().encode('archive');
    const manifest = manifestFor(archive);
    let fetchCalls = 0;
    let extractionAttempts = 0;
    const manager = createManagedLocalModelManager({
      root,
      manifest,
      fetchArtifact: async () => {
        fetchCalls += 1;
        return new Response(archive, { status: 200 });
      },
      extractArchive: async (_archivePath, stagingPath) => {
        extractionAttempts += 1;
        if (extractionAttempts > 1) {
          const extracted = join(stagingPath, manifest.archiveRoot);
          await mkdir(extracted, { recursive: true });
          await writeFile(join(extracted, 'tokens.txt'), 'test');
          return;
        }
        await writeFile(join(stagingPath, 'interrupted'), 'partial');
        throw new Error('Extraction interrupted.');
      },
    });

    await expect(manager.install()).rejects.toThrow('interrupted');
    expect(await manager.getState()).toMatchObject({ kind: 'error', action: 'resume' });
    expect(await readFile(join(root, 'test-model-1.partial'))).toEqual(archive);

    await manager.install();
    expect((await manager.getState()).kind).toBe('ready');
    expect(fetchCalls).toBe(1);

    await manager.delete();
    expect(await manager.getState()).toEqual({ kind: 'missing', modelId: 'test-model' });
  });
});
