import { describe, expect, it } from 'bun:test';
import { resolve } from 'path';

const projectRoot = resolve(import.meta.dir, '..', '..', '..');

async function readProjectFile(relativePath: string): Promise<string> {
  const file = Bun.file(resolve(projectRoot, relativePath));
  return await file.text();
}

function parseMajorVersion(range: string): number {
  const match = range.match(/(?:\^|~|>=|<=|>|<|=)?\s*(\d+)/);
  if (!match) {
    throw new Error(`Could not parse major version from range: ${range}`);
  }
  return Number.parseInt(match[1], 10);
}

function parseNodeVersion(value: string): { major: number; minor: number; patch: number } {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Could not parse Node version from: ${value}`);
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function isAtLeastNode(value: string, required: { major: number; minor: number; patch: number }): boolean {
  const version = parseNodeVersion(value);
  if (version.major !== required.major) return version.major > required.major;
  if (version.minor !== required.minor) return version.minor > required.minor;
  return version.patch >= required.patch;
}

describe('toolchain configuration', () => {
  it('does not use the deprecated externalizeDepsPlugin in electron-vite config', async () => {
    const configSource = await readProjectFile('electron.vite.config.ts');
    expect(configSource).not.toContain('externalizeDepsPlugin');
  });

  it('pins Electron to a v43 release', async () => {
    const manifest = JSON.parse(await readProjectFile('package.json')) as Record<string, unknown>;
    const electronRange = (manifest.devDependencies as Record<string, string>).electron;
    expect(parseMajorVersion(electronRange)).toBe(43);
  });

  it('pins electron-builder to a v26 release', async () => {
    const manifest = JSON.parse(await readProjectFile('package.json')) as Record<string, unknown>;
    const builderRange = (manifest.devDependencies as Record<string, string>)['electron-builder'];
    expect(parseMajorVersion(builderRange)).toBe(26);
  });

  it('pins electron-vite to a v5 release', async () => {
    const manifest = JSON.parse(await readProjectFile('package.json')) as Record<string, unknown>;
    const electronViteRange = (manifest.devDependencies as Record<string, string>)['electron-vite'];
    expect(parseMajorVersion(electronViteRange)).toBe(5);
  });

  it('pins Vite to a v7 release', async () => {
    const manifest = JSON.parse(await readProjectFile('package.json')) as Record<string, unknown>;
    const viteRange = (manifest.devDependencies as Record<string, string>).vite;
    expect(parseMajorVersion(viteRange)).toBe(7);
  });

  it('requires a Node version compatible with electron-vite 5 and Vite 7', async () => {
    const manifest = JSON.parse(await readProjectFile('package.json')) as Record<string, unknown>;
    const engines = manifest.engines as Record<string, string> | undefined;
    expect(engines).toBeDefined();
    expect(engines?.node).toBeDefined();
    expect(isAtLeastNode(engines!.node, { major: 22, minor: 12, patch: 0 })).toBe(true);
  });

  it('pins CI to a compatible Node version', async () => {
    const ciSource = await readProjectFile('.github/workflows/ci.yml');
    expect(ciSource).toMatch(/node-version(?:-file)?:/);

    const explicitVersionMatch = ciSource.match(/node-version:\s*(.+)/);
    const versionFileMatch = ciSource.match(/node-version-file:\s*(.+)/);

    if (explicitVersionMatch) {
      expect(isAtLeastNode(explicitVersionMatch[1].trim(), { major: 22, minor: 12, patch: 0 })).toBe(true);
    } else if (versionFileMatch) {
      const versionFile = versionFileMatch[1].trim();
      const versionFileContents = (await readProjectFile(versionFile)).trim();
      expect(isAtLeastNode(versionFileContents, { major: 22, minor: 12, patch: 0 })).toBe(true);
    } else {
      throw new Error('CI does not specify a Node version or version file');
    }
  });

  it('pins local development to a compatible Node version via .nvmrc', async () => {
    const nvmrc = (await readProjectFile('.nvmrc')).trim();
    expect(isAtLeastNode(nvmrc, { major: 22, minor: 12, patch: 0 })).toBe(true);
  });
});
