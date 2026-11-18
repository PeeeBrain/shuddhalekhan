import { expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createComputerUseInstaller, installComputerUseRelease } from '../computer-use';

const cases: { failure: string; wrongDigest?: boolean; extraMember?: boolean }[] = [
  { failure: 'integrity check', wrongDigest: true },
  { failure: 'unexpected files', extraMember: true },
  { failure: 'version check' },
];

for (const { failure, wrongDigest, extraMember } of cases) {
  it.skipIf(process.platform !== 'linux')(`rejects a release that fails the ${failure} without promoting it`, async () => {
    const temp = mkdtempSync(join(tmpdir(), 'computer-use-install-test-'));
    const fetch = spyOn(globalThis, 'fetch');
    try {
      const source = join(temp, 'source');
      mkdirSync(source);
      const names = ['agent-desktop', 'agent-desktop-linux-clipboard-owner'];
      if (extraMember) names.push('unexpected');
      for (const name of names) writeFileSync(join(source, name), '#!/bin/sh\nprintf \'{"ok":true,"data":{"version":"0"}}\'\n');
      const archive = join(temp, 'fixture.tar.gz');
      execFileSync('tar', ['-czf', archive, '-C', source, ...names]);
      const bytes = readFileSync(archive);
      const destination = join(temp, 'installed');
      fetch.mockImplementation(async () => new Response(new Uint8Array(bytes)));
      await expect(installComputerUseRelease(destination, {
        url: 'https://github.com/release.tar.gz',
        bytes: bytes.length,
        sha256: wrongDigest ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
      }, new AbortController().signal, () => undefined)).rejects.toThrow(failure);
      expect(readdirSync(temp).sort()).toEqual(['fixture.tar.gz', 'source']);
    } finally {
      fetch.mockRestore();
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

it.skipIf(process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))(
  'cancels an incomplete download and returns to absent with no staged files',
  async () => {
    const temp = mkdtempSync(join(tmpdir(), 'computer-use-cancel-test-'));
    const fetch = spyOn(globalThis, 'fetch');
    let downloading: () => void = () => undefined;
    const reading = new Promise<void>(resolve => { downloading = resolve; });
    const installer = createComputerUseInstaller(temp, () => undefined);
    let bodyCancelled = false;
    try {
      fetch.mockImplementation(async () => new Response(new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          downloading();
          return new Promise<void>(() => undefined);
        },
        cancel() { bodyCancelled = true; },
      }, { highWaterMark: 0 })));
      expect(installer.status()).toEqual({ state: 'absent' });
      expect(fetch).not.toHaveBeenCalled();
      const install = installer.install();
      await reading;
      expect(installer.status().state).toBe('installing');
      await installer.cancelInstall();
      expect(await install).toEqual({ state: 'absent' });
      expect(bodyCancelled).toBe(true);
      expect(readdirSync(join(temp, 'computer-use'))).toEqual([]);
    } finally {
      await installer.cancelInstall();
      fetch.mockRestore();
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
