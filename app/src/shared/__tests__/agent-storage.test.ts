import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

it('preserves real filesystem skills, Markdown memory, and atomic replacement contracts', async () => {
  // Config tests mock fs globally. Real disk contracts need a fresh process.
  const fixtures = [
    './fixtures/agent-skills.ts',
    './fixtures/atomic-file.ts',
    '../../main/__tests__/fixtures/agent-memory.ts',
  ].map(path => fileURLToPath(new URL(path, import.meta.url)));
  const child = Bun.spawn([process.execPath, 'test', ...fixtures], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  expect(exitCode, stderr).toBe(0);
}, 20_000);
