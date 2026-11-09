import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'path';
import { ManagedStdioMcpTransport } from '../managed-stdio-transport';

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
    env: { FIXTURE_TOKEN: 's3cret-value' },
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

  it('launches shell-free with only declared env and pipes JSON-RPC both ways', async () => {
    const transport = track(new ManagedStdioMcpTransport({ launch: launchArgs() }));
    const messages: unknown[] = [];
    transport.onmessage = (message) => messages.push(message);

    const pid = await startTransport(transport);
    expect(isPidAlive(pid)).toBe(true);

    await transport.send({ jsonrpc: '2.0', id: 1, method: 'getEnv' });
    await transport.send({ jsonrpc: '2.0', id: 2, method: 'ping' });

    // The fixture also announces itself with id 0, so wait for both replies by id.
    await waitFor(() => [1, 2].every((id) => messages.some((message) => (message as { id?: number }).id === id)));
    const envReply = messages.find((message) => (message as { id?: number }).id === 1) as {
      result?: { declared?: string | null; home?: string | null; userProfile?: string | null };
    };
    expect(envReply.result?.declared).toBe('s3cret-value');
    expect(envReply.result?.home).toBeNull();

    const echoReply = messages.find((message) => (message as { id?: number }).id === 2) as {
      result?: { echoed?: string };
    };
    expect(echoReply.result?.echoed).toBe('ping');
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

  it('reports malformed stdout as an error without crashing the transport', async () => {
    const transport = track(new ManagedStdioMcpTransport({
      launch: launchArgs(),
      redactValues: ['s3cret-value'],
    }));
    const errors: unknown[] = [];
    const messages: unknown[] = [];
    transport.onerror = (error) => errors.push(error);
    transport.onmessage = (message) => messages.push(message);

    await transport.start();
    await waitFor(() => messages.length > 0);
    await transport.send({ jsonrpc: '2.0', id: 7, method: 'emitSecretMalformed' });

    await waitFor(() => errors.length > 0);
    expect(String(errors[0])).toContain('not-json [redacted]');
    expect(String(errors[0])).not.toContain('s3cret-value');
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
