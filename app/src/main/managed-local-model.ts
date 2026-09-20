import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { createReadStream } from 'fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from 'fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'path';
import type { ManagedLocalModelState } from '../types/ipc';

export interface ManagedLocalModelManifest {
  id: string;
  version: string;
  name: string;
  downloadBytes: number;
  installedBytes: number;
  languages: string[];
  artifactUrl: string;
  sha256: string;
  archiveRoot: string;
  requiredFiles: string[];
}

export const MANAGED_LOCAL_MODEL = {
  id: 'parakeet-tdt-0.6b-v3-int8',
  version: '1',
  name: 'Recommended local speech model',
  downloadBytes: 487_170_055,
  installedBytes: 640_000_000,
  languages: [
    'English', 'French', 'German', 'Spanish', 'Italian', 'Portuguese', 'Dutch',
    'Polish', 'Czech', 'Slovak', 'Romanian', 'Hungarian', 'Bulgarian', 'Croatian',
    'Slovenian', 'Lithuanian', 'Latvian', 'Estonian', 'Finnish', 'Maltese',
    'Swedish', 'Danish', 'Greek', 'Russian', 'Ukrainian',
  ],
  artifactUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
  sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
  archiveRoot: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
  requiredFiles: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
} satisfies ManagedLocalModelManifest;

type FetchArtifact = (url: string, init: RequestInit) => Promise<Response>;
type ExtractArchive = (archivePath: string, stagingPath: string) => Promise<void>;

export function createManagedLocalModelManager({
  root,
  manifest = MANAGED_LOCAL_MODEL,
  fetchArtifact = fetch,
  extractArchive = extractTarBz2,
  onStateChanged = () => {},
}: {
  root: string;
  manifest?: ManagedLocalModelManifest;
  fetchArtifact?: FetchArtifact;
  extractArchive?: ExtractArchive;
  onStateChanged?: (state: ManagedLocalModelState) => void;
}) {
  const installPath = join(root, `${manifest.id}-${manifest.version}`);
  const partialPath = join(root, `${manifest.id}-${manifest.version}.partial`);
  const stagingPath = join(root, `${manifest.id}-${manifest.version}.staging`);
  let current: ManagedLocalModelState = { kind: 'missing', modelId: manifest.id };
  let activeInstall: Promise<void> | null = null;

  const publish = (state: ManagedLocalModelState): void => {
    current = state;
    onStateChanged(state);
  };

  const getState = async (): Promise<ManagedLocalModelState> => {
    if (current.kind === 'downloading' || current.kind === 'installing') return current;
    if (current.kind === 'error') return current;
    if (await isValidInstall(installPath, manifest.requiredFiles)) {
      return { kind: 'ready', modelId: manifest.id, path: installPath };
    }
    return { kind: 'missing', modelId: manifest.id };
  };

  const runInstall = async (): Promise<void> => {
    await mkdir(root, { recursive: true });
    let resumeAt = await fileSize(partialPath);
    if (resumeAt > manifest.downloadBytes) {
      await rm(partialPath, { force: true });
      resumeAt = 0;
    }
    publish({
      kind: 'downloading',
      modelId: manifest.id,
      downloadedBytes: resumeAt,
      totalBytes: manifest.downloadBytes,
    });

    try {
      if (resumeAt !== manifest.downloadBytes) {
        const response = await fetchArtifact(manifest.artifactUrl, {
          headers: resumeAt > 0 ? { Range: `bytes=${resumeAt}-` } : {},
        });
        if (!response.ok || !response.body) {
          throw new Error(`Model download failed with HTTP ${response.status}.`);
        }
        const append = resumeAt > 0 && response.status === 206;
        const file = await open(partialPath, append ? 'a' : 'w');
        let downloadedBytes = append ? resumeAt : 0;
        try {
          const reader = response.body.getReader();
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            await file.write(chunk.value);
            downloadedBytes += chunk.value.byteLength;
            publish({
              kind: 'downloading',
              modelId: manifest.id,
              downloadedBytes,
              totalBytes: manifest.downloadBytes,
            });
          }
        } finally {
          await file.close();
        }
      }

      if (await sha256(partialPath) !== manifest.sha256) {
        await rm(partialPath, { force: true });
        throw new Error('The downloaded model failed its integrity check. Retry the download.');
      }

      publish({ kind: 'installing', modelId: manifest.id });
      await rm(stagingPath, { recursive: true, force: true });
      await mkdir(stagingPath, { recursive: true });
      await extractArchive(partialPath, stagingPath);
      const extractedPath = join(stagingPath, manifest.archiveRoot);
      if (!await isValidInstall(extractedPath, manifest.requiredFiles)) {
        throw new Error('The model archive is missing required files. Repair the installation.');
      }
      await rejectLinks(extractedPath);
      await rm(installPath, { recursive: true, force: true });
      await rename(extractedPath, installPath);
      await rm(stagingPath, { recursive: true, force: true });
      await rm(partialPath, { force: true });
      publish({ kind: 'ready', modelId: manifest.id, path: installPath });
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : 'Model installation failed.';
      const action = await fileSize(partialPath) > 0 ? 'resume' : 'retry';
      publish({ kind: 'error', modelId: manifest.id, message, action });
      throw error;
    }
  };

  return {
    manifest,
    getState,
    install(): Promise<void> {
      if (!activeInstall) {
        activeInstall = runInstall().finally(() => {
          activeInstall = null;
        });
      }
      return activeInstall;
    },
    async delete(): Promise<void> {
      await rm(installPath, { recursive: true, force: true });
      await rm(partialPath, { force: true });
      await rm(stagingPath, { recursive: true, force: true });
      publish({ kind: 'missing', modelId: manifest.id });
    },
    reportFailure(message: string): void {
      publish({ kind: 'error', modelId: manifest.id, message, action: 'repair' });
    },
  };
}

export function validateArchiveEntries(entries: string[]): void {
  for (const entry of entries) {
    const normalized = normalize(entry.replace(/\\/g, '/'));
    if (
      !entry
      || isAbsolute(entry)
      || normalized === '..'
      || normalized.startsWith(`..${sep}`)
      || /^[A-Za-z]:/.test(entry)
    ) {
      throw new Error('The model archive contains an unsafe path.');
    }
  }
}

async function extractTarBz2(archivePath: string, stagingPath: string): Promise<void> {
  const entries = (await runTar(['-tjf', archivePath])).split(/\r?\n/).filter(Boolean);
  validateArchiveEntries(entries);
  const verbose = (await runTar(['-tvjf', archivePath])).split(/\r?\n/).filter(Boolean);
  if (verbose.some((line) => line[0] !== '-' && line[0] !== 'd')) {
    throw new Error('The model archive contains unsupported links or device entries.');
  }
  await runTar(['-xjf', archivePath, '-C', stagingPath]);
}

function runTar(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar.exe', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || 'Could not extract the model archive.'));
    });
  });
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function isValidInstall(path: string, requiredFiles: string[]): Promise<boolean> {
  return (await Promise.all(requiredFiles.map(async (file) => {
    try {
      return (await lstat(join(path, file))).isFile();
    } catch {
      return false;
    }
  }))).every(Boolean);
}

async function rejectLinks(root: string): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('The model archive contains an unsafe link.');
    if (!info.isDirectory()) return;
    for (const entry of await readdir(path)) {
      const child = join(path, entry);
      const childRelative = relative(root, child);
      if (childRelative.startsWith('..') || isAbsolute(childRelative)) {
        throw new Error('The model archive contains an unsafe path.');
      }
      await visit(child);
    }
  };
  await visit(root);
}
