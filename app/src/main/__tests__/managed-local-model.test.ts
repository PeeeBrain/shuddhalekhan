import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createManagedLocalModelManager,
  replaceDirectory,
  validateArchiveEntries,
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

function manifestFor(bytes: Uint8Array) {
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
  it('installs verified plain files side by side, resuming only the unfinished one', async () => {
    const root = await tempRoot();
    const onnx = new TextEncoder().encode('encoder graph');
    const weights = new TextEncoder().encode('external encoder weights');
    const file = (name: string, bytes: Uint8Array) => ({ name, url: `https://models.example/${name}`, bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex') });
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'test-model-1.partial-encoder.onnx'), onnx);
    await writeFile(join(root, 'test-model-1.partial-encoder.weights'), weights.slice(0, 8));
    const requests: string[] = [];
    const manager = createManagedLocalModelManager({ root,
      manifest: { id: 'test-model', version: '1', name: 'Test model', languages: [], installedBytes: 0,
        downloadBytes: onnx.byteLength + weights.byteLength, requiredFiles: ['encoder.onnx', 'encoder.weights'],
        files: [file('encoder.onnx', onnx), file('encoder.weights', weights)] },
      fetchArtifact: async (url, init) => {
        requests.push(`${url} ${new Headers(init.headers).get('Range')}`);
        return new Response(weights.slice(8), { status: 206, headers: { 'Content-Range': `bytes 8-${weights.byteLength - 1}/${weights.byteLength}` } });
      },
      extractArchive: async () => { throw new Error('Plain files are not an archive'); },
    });
    await manager.install();
    expect(requests).toEqual(['https://models.example/encoder.weights bytes=8-']);
    expect(await manager.getState()).toMatchObject({ kind: 'ready' });
    expect(await readFile(join(root, 'test-model-1/encoder.onnx'))).toEqual(onnx);
    expect(await readFile(join(root, 'test-model-1/encoder.weights'))).toEqual(weights);
  });
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
        return new Response(archive.slice(3), {
          status: 206,
          headers: { 'Content-Range': `bytes 3-${archive.byteLength - 1}/${archive.byteLength}` },
        });
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

  it('rejects a download that exceeds the pinned artifact size', async () => {
    const root = await tempRoot();
    const archive = new TextEncoder().encode('archive');
    const manager = createManagedLocalModelManager({
      root,
      manifest: manifestFor(archive),
      fetchArtifact: async (_url, init) => {
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return new Response('archive-too-large', { status: 200 });
      },
    });

    await expect(manager.install()).rejects.toThrow('larger than expected');
    await expect(access(join(root, 'test-model-1.partial'))).rejects.toThrow();
  });

  it('restores the current installation when replacement promotion fails', async () => {
    const root = await tempRoot();
    const current = join(root, 'current');
    await mkdir(current);
    await writeFile(join(current, 'tokens.txt'), 'current');

    await expect(replaceDirectory(join(root, 'missing'), current)).rejects.toThrow();

    expect(await readFile(join(current, 'tokens.txt'), 'utf8')).toBe('current');
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

  it('keeps previous-release files usable until an explicit replacement succeeds, then deletes them only on request', async () => {
    const root = await tempRoot();
    const archive = new TextEncoder().encode('archive');
    const manifest = manifestFor(archive);
    const legacyPath = join(root, 'old-model-1');
    await mkdir(legacyPath);
    await writeFile(join(legacyPath, 'tokens.txt'), 'old');
    let extraction = 0;
    let finishExtraction = () => {};
    let extracting = () => {};
    const extractionStarted = new Promise<void>((resolve) => { extracting = resolve; });
    const manager = createManagedLocalModelManager({
      root, manifest,
      legacy: { id: 'old-model', version: '1', name: 'Old model', downloadBytes: 1, installedBytes: 1,
        languages: ['English'], requiredFiles: ['tokens.txt'] },
      fetchArtifact: async () => new Response(archive),
      extractArchive: async (_archivePath, stagingPath) => {
        if (++extraction === 1) throw new Error('Extraction failed.');
        extracting();
        await new Promise<void>((resolve) => { finishExtraction = resolve; });
        await mkdir(join(stagingPath, manifest.archiveRoot), { recursive: true });
        await writeFile(join(stagingPath, manifest.archiveRoot, 'tokens.txt'), 'new');
      },
    });
    const usable = { kind: 'ready', modelId: 'old-model', path: legacyPath };

    expect(await manager.getState()).toEqual(usable);
    expect((await manager.getInstallState()).kind).toBe('missing');

    await expect(manager.install()).rejects.toThrow('Extraction failed');
    expect(await manager.getState()).toEqual(usable);
    expect((await manager.getInstallState()).kind).toBe('error');

    const install = manager.install();
    await extractionStarted;
    expect((await manager.getInstallState()).kind).toBe('installing');
    expect(await manager.getState()).toEqual(usable);
    finishExtraction();
    await install;

    expect(await manager.getState()).toEqual({ kind: 'ready', modelId: 'test-model', path: join(root, 'test-model-1') });
    expect(await manager.getLegacy()).toMatchObject({ name: 'Old model', path: legacyPath });

    await manager.deleteLegacy();
    expect(await manager.getLegacy()).toBeNull();
    await expect(access(legacyPath)).rejects.toThrow();
    expect((await manager.getState()).modelId).toBe('test-model');
  });
});
