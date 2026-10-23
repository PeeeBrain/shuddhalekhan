import { describe, expect, it } from 'bun:test';
import { resolve } from 'path';

const repositoryRoot = resolve(import.meta.dir, '..', '..', '..', '..');

const workflowPaths = ['.github/workflows/ci.yml', '.github/workflows/release.yml'];

async function readRepositoryFile(relativePath: string): Promise<string> {
  return await Bun.file(resolve(repositoryRoot, relativePath)).text();
}

describe('toolchain configuration', () => {
  it('pins CI and release workflows to the repository packageManager Bun version', async () => {
    const manifest = JSON.parse(await readRepositoryFile('package.json')) as {
      packageManager?: string;
    };

    for (const workflow of workflowPaths) {
      const source = await readRepositoryFile(workflow);
      const bunVersion = source.match(/bun-version:\s*(\S+)/)?.[1];
      expect(bunVersion).toBeDefined();
      expect(manifest.packageManager).toBe(`bun@${bunVersion}`);
    }
  });
});
