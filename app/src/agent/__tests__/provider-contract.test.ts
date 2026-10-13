import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

it('uses the real SDK for provider requests, streaming, tool continuation, and diagnostics', async () => {
  // Existing runtime tests mock SDK modules globally. A fresh process keeps
  // this contract test independent of test ordering and those mocks.
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./fixtures/provider-contract.ts', import.meta.url))], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const [exitCode, output, error] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ exitCode, error }).toEqual({ exitCode: 0, error: '' });
  expect(output).toContain('Provider contracts passed');
}, 20_000);
