import { expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createComputerUseRun } from '../computer-use';
import type { ComputerUseConfig, ComputerUseToolName } from '../../shared/computer-use';

const fixture = join(import.meta.dir, 'fixtures', 'computer-use-server.ts');
const context = { messages: [], toolCallId: 'test', context: {} };
const linux = process.platform === 'linux';

function withAdapter(executable: string) {
  const abort = new AbortController();
  const config: ComputerUseConfig = { enabled: true, toolPolicies: {} };
  const run = createComputerUseRun({
    executable, signal: abort.signal, getConfig: () => config,
    onToolStarted: () => undefined, onToolFinished: () => undefined,
  });
  async function call(name: ComputerUseToolName, args: unknown = {}) {
    const execute = run.tools[`native-computer__${name}`]?.execute;
    if (!execute) throw new Error(`${name} is unavailable`);
    return z.string().parse(await execute(args, context));
  }
  return { ...run, abort, call, config };
}

it.skipIf(!linux)('uses latest snapshot refs, applies live policies, and reaps the private MCP process on abort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-mcp-fixture-'));
  const path = join(dir, 'server');
  const log = path + '.calls';
  writeFileSync(path, `#!${process.execPath}\nimport ${JSON.stringify(fixture)};\n`, { mode: 0o700 });
  const previousKey = process.env.NATIVE_FIXTURE_KEY;
  process.env.NATIVE_FIXTURE_KEY = 'private';
  const run = withAdapter(path);
  try {
    expect(existsSync(log)).toBe(false);
    expect(run.tools['native-computer__desktop_clipboard_get']).toBeUndefined();
    const result = await run.call('desktop_list_apps');
    const { home, pid, secretInherited } = z.object({
      data: z.object({ home: z.string(), pid: z.number(), secretInherited: z.boolean() }),
    }).parse(JSON.parse(result)).data;
    expect(secretInherited).toBe(false);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    // A malformed result fails that call only; the session keeps working.
    expect(await run.call('desktop_list_windows')).toMatch(/^INVALID_RESULT:/);
    const target = { app: 'Fixture', window_id: '1' };
    await run.call('desktop_snapshot', target);
    await run.call('desktop_snapshot', target);
    expect(await run.call('desktop_click', { ref_id: '@snap1:e1' })).toMatch(/^STALE_REF:/);
    expect(await run.call('desktop_click', { ref_id: '@snap2:e99' })).toMatch(/^STALE_REF:/);
    expect(await run.call('desktop_launch', { app: 'Fixture', args: ['unexpected'] })).toMatch(/^INVALID_INPUT:/);
    run.config.toolPolicies.desktop_click = 'disabled';
    expect(await run.call('desktop_click', { ref_id: '@snap2:e1' })).toMatch(/^COMPUTER_USE_DISABLED:/);
    run.config.toolPolicies.desktop_click = 'alwaysAllow';
    expect(await run.call('desktop_click', { ref_id: '@snap2:e1' })).toContain('"ok":true');

    const watching = watch(log);
    try {
      const enteredWait = new Promise<void>(resolve => {
        watching.on('change', () => {
          if (readFileSync(log, 'utf8').includes('desktop_wait\n')) resolve();
        });
      });
      const pending = run.call('desktop_wait', { element: '@snap2:e1' });
      await enteredWait;
      run.abort.abort();
      expect(await pending).toMatch(/^COMPUTER_USE_FAILED:/);
      await run.close();
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
        'desktop_list_apps', 'desktop_list_windows', 'desktop_snapshot', 'desktop_snapshot', 'desktop_click', 'desktop_wait', 'cancelled',
      ]);
      expect(existsSync(home)).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      watching.close();
    }
  } finally {
    if (previousKey === undefined) delete process.env.NATIVE_FIXTURE_KEY;
    else process.env.NATIVE_FIXTURE_KEY = previousKey;
    await run.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.skipIf(!linux)('fails the close but still removes window state when the helper dies mid-call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-mcp-fixture-'));
  const path = join(dir, 'server-crash');
  writeFileSync(path, `#!${process.execPath}\nimport ${JSON.stringify(fixture)};\n`, { mode: 0o700 });
  const run = withAdapter(path);
  try {
    const { home } = z.object({ data: z.object({ home: z.string() }) }).parse(JSON.parse(await run.call('desktop_list_apps'))).data;
    await run.call('desktop_snapshot', { app: 'Fixture', window_id: '1' });
    expect(await run.call('desktop_wait', { element: '@snap1:e1' })).toMatch(/^COMPUTER_USE_FAILED:/);
    // Its command may still be running, so the sidecar must fall back to its process group.
    await expect(run.close()).rejects.toThrow('did not stop');
    expect(existsSync(home)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.skipIf(!linux)('fails closed when the MCP catalog is missing even a curated tool the model did not call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-mcp-fixture-'));
  const path = join(dir, 'server-drift');
  writeFileSync(path, `#!${process.execPath}\nimport ${JSON.stringify(fixture)};\n`, { mode: 0o700 });
  const run = withAdapter(path);
  try {
    expect(await run.call('desktop_list_windows')).toMatch(/^CATALOG_MISMATCH:/);
    expect(existsSync(path + '.calls')).toBe(false);
  } finally {
    await run.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
