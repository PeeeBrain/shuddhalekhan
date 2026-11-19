import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, rm, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { COMPUTER_USE_VERSION, type ComputerUseStatus } from '../shared/computer-use';
import { extractTar, replaceDirectory } from './managed-local-model';

const windows = process.platform === 'win32';
// Exactly the files each archive holds; the first is the helper.
const members = windows ? ['agent-desktop.exe'] : ['agent-desktop', 'agent-desktop-linux-clipboard-owner'];
const artifact = (target: string, bytes: number, sha256: string) => ({
  url: `https://github.com/vercel-labs/agent-desktop/releases/download/v${COMPUTER_USE_VERSION}/agent-desktop-v${COMPUTER_USE_VERSION}-${target}.tar.gz`,
  bytes,
  sha256,
});
const releases: Partial<Record<string, ReturnType<typeof artifact>>> = {
  'linux-x64': artifact('x86_64-unknown-linux-gnu', 3_537_152, 'ca77b6b75034eeb12e537dd8c0a4f2a3424119253f38b7e6bd79ba0d2fef1264'),
  'linux-arm64': artifact('aarch64-unknown-linux-gnu', 3_407_558, '438990a703fbeb19775596c341c3701435e80adbfa1b2f64b82ff17567d5573b'),
  'win32-x64': artifact('x86_64-pc-windows-msvc', 1_835_706, '6ee4b1e078f4e78792e79f16e32e4a78b9919464aa3c55629b7e27ed53a08c13'),
  'win32-arm64': artifact('aarch64-pc-windows-msvc', 1_779_550, '805f1f61890f9983fceaf38cda94a37a049c379435d65607db5cedd22c8ef97b'),
};
const origins = new Set([
  'https://github.com', 'https://objects.githubusercontent.com', 'https://release-assets.githubusercontent.com',
]);
const release = releases[`${process.platform}-${process.arch}`] ?? null;
const healthSchema = z.object({ ok: z.literal(true), data: z.object({ version: z.literal(COMPUTER_USE_VERSION) }) });

async function download(url: URL, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  for (let redirects = 0; redirects < 5; redirects++) {
    if (url.username || url.password || !origins.has(url.origin)) {
      throw new Error('The Computer Use download redirected to an untrusted address.');
    }
    const response = await fetch(url, { signal, redirect: 'manual' });
    const location = response.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    if (response.status === 200 && response.body) return response.body;
    await response.body?.cancel();
    throw new Error(`The Computer Use download failed (HTTP ${response.status}).`);
  }
  throw new Error('The Computer Use download redirected too many times.');
}

/** Verify and stage one release on the same filesystem as its final directory. */
export async function installComputerUseRelease(
  destination: string,
  artifact: { url: string; bytes: number; sha256: string },
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<void> {
  const staging = await mkdtemp(join(dirname(destination), '.stage-'));
  try {
    const archive = join(staging, 'release.tar.gz');
    const hash = createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > artifact.bytes) {
          callback(new Error('The Computer Use archive is larger than expected.'));
          return;
        }
        hash.update(chunk);
        onProgress(received);
        callback(null, chunk);
      },
    });
    const body = await download(new URL(artifact.url), signal);
    await pipeline(body, meter, createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
    if (received !== artifact.bytes || hash.digest('hex') !== artifact.sha256) {
      throw new Error('The Computer Use download failed its integrity check.');
    }
    const bin = join(staging, 'bin');
    await mkdir(bin, { mode: 0o700 });
    signal.throwIfAborted();
    await extractTar(archive, bin, members, true);
    await Promise.all(members.map(name => chmod(join(bin, name), 0o700)));
    signal.throwIfAborted();
    try {
      const { stdout } = await promisify(execFile)(join(bin, members[0]), ['version'], {
        // Windows system DLLs need SystemRoot even for a version check.
        cwd: staging, env: { HOME: staging, AGENT_DESKTOP_HOME: staging, ...(windows ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}) },
        timeout: 3000, maxBuffer: 4096, killSignal: 'SIGKILL', signal,
      });
      healthSchema.parse(JSON.parse(stdout));
    } catch {
      signal.throwIfAborted();
      throw new Error('The installed Computer Use binary failed its version check.');
    }
    signal.throwIfAborted();
    await replaceDirectory(bin, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function createComputerUseInstaller(dataDirectory: string, onChange: (status: ComputerUseStatus) => void) {
  // The version check runs from a staging cwd, so a relative profile directory must not stay relative.
  const root = resolve(dataDirectory, 'computer-use');
  const destination = join(root, `agent-desktop-v${COMPUTER_USE_VERSION}`);
  let current: ComputerUseStatus | undefined;
  let pending: { controller: AbortController; result: Promise<ComputerUseStatus> } | undefined;
  let removal: Promise<ComputerUseStatus> | undefined;

  function executable() {
    if (!release || removal) return undefined;
    try {
      if (!lstatSync(destination).isDirectory() || !members.every(name => {
        const file = lstatSync(join(destination, name));
        // Windows has no execute bit.
        return file.isFile() && (windows || (file.mode & 0o100) !== 0);
      })) return undefined;
      return join(destination, members[0]);
    } catch {
      return undefined;
    }
  }

  function status(): ComputerUseStatus {
    if (!release) return { state: 'unsupported', reason: 'Computer Use requires Linux or Windows on x64 or ARM64.' };
    if (current?.state === 'installing') return current;
    if (executable()) return { state: 'installed' };
    return current?.state === 'failed' ? current : { state: 'absent' };
  }

  function publish(next: ComputerUseStatus) {
    current = next;
    onChange(next);
    return next;
  }

  async function install(): Promise<ComputerUseStatus> {
    if (removal) await removal;
    if (pending) return pending.result;
    const initial = status();
    if (!release || initial.state === 'installed') return initial;
    const artifact = release;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
    let lastProgress = Date.now();
    publish({ state: 'installing', receivedBytes: 0, totalBytes: artifact.bytes });
    const result = (async () => {
      try {
        await mkdir(root, { recursive: true, mode: 0o700 });
        await installComputerUseRelease(destination, artifact, signal, receivedBytes => {
          const now = Date.now();
          current = { state: 'installing', receivedBytes, totalBytes: artifact.bytes };
          if (now - lastProgress >= 200) {
            lastProgress = now;
            onChange(current);
          }
        });
        return publish({ state: 'installed' });
      } catch (error) {
        return publish(controller.signal.aborted ? { state: 'absent' } : {
          state: 'failed',
          reason: signal.aborted ? 'The Computer Use download timed out.' :
            error instanceof Error ? error.message : 'Computer Use installation failed.',
        });
      } finally {
        pending = undefined;
      }
    })();
    pending = { controller, result };
    return result;
  }

  async function cancelInstall(): Promise<void> {
    const operation = pending;
    operation?.controller.abort();
    await operation?.result;
  }

  function uninstall(disableAndClose: () => Promise<void>): Promise<ComputerUseStatus> {
    removal ??= (async () => {
      try {
        await cancelInstall();
        await disableAndClose();
        if (!release) return status();
        // The whole root: a crashed install leaves a staging folder beside the release.
        await rm(root, { recursive: true, force: true });
        return publish({ state: 'absent' });
      } finally {
        removal = undefined;
      }
    })();
    return removal;
  }

  return { executable, status, install, cancelInstall, uninstall };
}
