import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'path';
import { ManagedStdioMcpTransport } from '../managed-stdio-transport';

const FIXTURE = join(import.meta.dir, 'fixtures', 'stdio-server-fixture.ts');

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

    await transport.start();
    expect(transport.getPid()).toBeTypeOf('number');

    await transport.send({ jsonrpc: '2.0', id: 1, method: 'getEnv' });
    await transport.send({ jsonrpc: '2.0', id: 2, method: 'ping' });

    await waitFor(() => messages.length >= 2);
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

  it('bounds and redacts server stderr containing secret values', async () => {
    const transport = track(
      new ManagedStdioMcpTransport({
        launch: launchArgs(['--flood-stderr']),
        stderrMaxBytes: 4096,
        redactValues: ['s3cret-value'],
      })
    );

    await transport.start();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const stderr = transport.getRecentStderr();
    expect(stderr.length).toBeLessThanOrEqual(4096);
    expect(stderr).not.toContain('s3cret-value');
    expect(stderr).toContain('[redacted]');
  });

  it('closes gracefully through stdin EOF and fires onclose once', async () => {
    const transport = track(new ManagedStdioMcpTransport({ launch: launchArgs() }));
    let closeCount = 0;
    transport.onclose = () => {
      closeCount += 1;
    };

    await transport.start();
    const pid = transport.getPid();
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

    await transport.start();
    const pid = transport.getPid();

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

    await transport.start();
    const pid = transport.getPid()!;
    process.kill(pid, 'SIGKILL');
    await waitFor(() => closeCount === 1);
    expect(transport.getPid()).toBeNull();

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

    await transport.start();
    const pid = transport.getPid()!;
    process.kill(pid, 'SIGKILL');
    await waitFor(() => transport.getPid() === null);

    await transport.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
    await transport.close();

    expect(errors).toEqual([]);
  });

  it('settles a backpressured send when the server dies mid-write', async () => {
    const transport = track(new ManagedStdioMcpTransport({ launch: launchArgs() }));

    await transport.start();
    // A payload far past the stdin high-water mark parks send in the drain wait.
    const backpressured = transport.send({
      jsonrpc: '2.0',
      method: 'flood',
      params: { blob: 'x'.repeat(1024 * 1024) },
    });
    const pid = transport.getPid()!;
    process.kill(pid, 'SIGKILL');
    await waitFor(() => transport.getPid() === null);

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
