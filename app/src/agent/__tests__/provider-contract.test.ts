import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

async function runFixture(name: string) {
  // Existing runtime tests mock SDK modules globally. A fresh process keeps
  // this contract test independent of test ordering and those mocks.
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url))], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const [exitCode, output, error] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ exitCode, error }).toEqual({ exitCode: 0, error: '' });
  return output;
}

it('uses the real SDK for provider requests, streaming, tool continuation, and diagnostics', async () => {
  expect(await runFixture('provider-contract')).toContain('Provider contracts passed');
}, 20_000);

it('preserves provider failures during cancellation races and terminates unexpected sidecar probe rejections', async () => {
  expect(await runFixture('provider-failure')).toContain('Provider failure contracts passed');
}, 20_000);
