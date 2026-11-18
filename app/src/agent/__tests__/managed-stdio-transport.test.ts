import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'path';
import { createMCPClient } from '@ai-sdk/mcp';
import { ManagedStdioMcpTransport } from '../managed-stdio-transport';
import { AisdkMcpClientFactory } from '../mcp-registry-adapters';

const FIXTURE = join(import.meta.dir, 'fixtures', 'stdio-server-fixture.ts');
const closedTransports = new WeakSet<ManagedStdioMcpTransport>();

async function startTransport(transport: ManagedStdioMcpTransport): Promise<number> {
  let pid: number | undefined;
  const onmessage = transport.onmessage;
  const onclose = transport.onclose;
  transport.onmessage = message => {
    if ('result' in message && message.result && typeof message.result === 'object'
      && 'pid' in message.result && typeof message.result.pid === 'number') pid = message.result.pid;
    onmessage?.(message);
  };
  transport.onclose = () => { closedTransports.add(transport); onclose?.(); };
  await transport.start();
  await waitFor(() => pid !== undefined);
  return pid!;
}

function launchArgs(extra: string[] = []): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: process.execPath,
    args: [FIXTURE, ...extra],
    env: {},
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('ManagedStdioMcpTransport', () => {
  const transports: ManagedStdioMcpTransport[] = [];

  afterEach(async () => {
    for (const transport of transports.splice(0)) {
      await transport.close().catch(() => undefined);
    }
  });

  function track(transport: ManagedStdioMcpTransport): ManagedStdioMcpTransport {
    transports.push(transport);
    return transport;
  }

  it('passes only declared secrets to stdio tools and redacts malformed output without losing the reply', async () => {
    const previousToken = process.env.FIXTURE_TOKEN;
    const previousUndeclared = process.env.FIXTURE_UNDECLARED;
    process.env.FIXTURE_TOKEN = 's3cret-value';
    process.env.FIXTURE_UNDECLARED = 'sidecar-secret';
    const errors: string[] = [];
    const factory = new AisdkMcpClientFactory({ resolve: () => undefined }, config =>
      createMCPClient({ ...config, onUncaughtError: error => { errors.push(String(error)); } }));

    try {
      const client = await factory.connect({
        id: 'stdio-fixture',
        displayName: 'Fixture',
        enabled: true,
        transport: { type: 'stdio', command: process.execPath, args: [FIXTURE, '--mcp'], envVarNames: ['FIXTURE_TOKEN'] },
        discoveredTools: [],
        toolPolicies: {},
      });
      try {
        const { check_environment: checkEnvironment } = await client.tools();
        if (!checkEnvironment?.execute) throw new Error('The stdio fixture tool was not discovered');
        const result = await checkEnvironment.execute({}, { messages: [], toolCallId: 'check-env', context: {} });
        expect(result).toMatchObject({
          structuredContent: { declared: true, pathAvailable: true, undeclared: false },
        });
        expect(errors).toContainEqual(expect.stringContaining('not-json [redacted]'));
        expect(errors.join('\n')).not.toContain('s3cret-value');
      } finally {
        await client.close();
      }
    } finally {
      if (previousToken === undefined) delete process.env.FIXTURE_TOKEN;
      else process.env.FIXTURE_TOKEN = previousToken;
      if (previousUndeclared === undefined) delete process.env.FIXTURE_UNDECLARED;
      else process.env.FIXTURE_UNDECLARED = previousUndeclared;
    }
  });

  it('closes gracefully through stdin EOF and fires onclose once', async () => {
    const transport = track(new ManagedStdioMcpTransport({ launch: launchArgs() }));
    let closeCount = 0;
    transport.onclose = () => {
      closeCount += 1;
    };

    const pid = await startTransport(transport);
    await transport.close();

    expect(closeCount).toBe(1);
    await waitFor(() => !isPidAlive(pid));
  });

  it('force-kills a server that ignores stdin EOF after the graceful timeout', async () => {
    const transport = track(
      new ManagedStdioMcpTransport({
        launch: launchArgs(['--ignore-stdin-eof']),
        gracefulCloseTimeoutMs: 300,
      })
    );

    const pid = await startTransport(transport);

    const startedAt = Date.now();
    await transport.close();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(4000);
    await waitFor(() => !isPidAlive(pid));
  });

  it('resolves close immediately for a server that already exited on its own', async () => {
    const transport = track(new ManagedStdioMcpTransport({ launch: launchArgs() }));
    let closeCount = 0;
    transport.onclose = () => {
      closeCount += 1;
    };

    const pid = await startTransport(transport);
    process.kill(pid, 'SIGKILL');
    await waitFor(() => closeCount === 1);
    expect(closedTransports.has(transport)).toBe(true);

    const startedAt = Date.now();
    await transport.close();

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(closeCount).toBe(1);
    await waitFor(() => !isPidAlive(pid));
  });

  it('drops sends after the server exited without crashing the transport', async () => {
    const transport = track(new ManagedStdioMcpTransport({ launch: launchArgs() }));
    const errors: unknown[] = [];
    transport.onerror = (error) => errors.push(error);

    const pid = await startTransport(transport);
    process.kill(pid, 'SIGKILL');
    await waitFor(() => closedTransports.has(transport));

    await transport.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
    await transport.close();

    expect(errors).toEqual([]);
  });

  it('settles a backpressured send when the server dies mid-write', async () => {
    const transport = track(new ManagedStdioMcpTransport({ launch: launchArgs() }));

    const pid = await startTransport(transport);
    // A payload far past the stdin high-water mark parks send in the drain wait.
    const backpressured = transport.send({
      jsonrpc: '2.0',
      method: 'flood',
      params: { blob: 'x'.repeat(1024 * 1024) },
    });
    process.kill(pid, 'SIGKILL');
    await waitFor(() => closedTransports.has(transport));

    await Promise.race([
      backpressured,
      new Promise((_, reject) => setTimeout(() => reject(new Error('send never settled')), 3000)),
    ]);
    await transport.close();
  });

  it('returns the same in-flight close promise to concurrent callers', async () => {
    const transport = track(
      new ManagedStdioMcpTransport({
        launch: launchArgs(['--ignore-stdin-eof']),
        gracefulCloseTimeoutMs: 300,
      })
    );

    await transport.start();
    const first = transport.close();
    expect(transport.close()).toBe(first);
    await first;
  });
});

function isPidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
