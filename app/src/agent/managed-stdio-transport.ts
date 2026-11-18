import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import type { JSONRPCMessage } from '@ai-sdk/mcp';
import { logSidecar } from './protocol';
import { MCP_STDIO_CLOSE_TIMEOUT_MS } from '../shared/agent-timeouts';

export type ManagedStdioLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type ManagedStdioOptions = {
  launch: ManagedStdioLaunch;
  gracefulCloseTimeoutMs?: number;
  redactValues?: string[];
  cancelToolCallsOnClose?: boolean;
};

const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = MCP_STDIO_CLOSE_TIMEOUT_MS;

// Application-owned stdio transport for managed MCP servers: hidden shell-free
// launch, piped stdio, and a graceful shutdown that
// ends stdin first and enforces termination only after a bounded wait.
export class ManagedStdioMcpTransport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly launch: ManagedStdioLaunch;
  private readonly gracefulCloseTimeoutMs: number;
  private readonly redactValues: string[];
  private readonly pendingToolCalls?: Set<string | number>;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private onCloseFired = false;
  constructor(options: ManagedStdioOptions) {
    this.launch = options.launch;
    if (options.cancelToolCallsOnClose) this.pendingToolCalls = new Set();
    this.gracefulCloseTimeoutMs =
      options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS;
    this.redactValues = (options.redactValues ?? []).filter((value) => value.length > 0);
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('The managed stdio transport is closed.');
    if (this.child) return;

    // Declared env values only: the server never inherits the sidecar env.
    const child = spawn(this.launch.command, this.launch.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: this.launch.env,
    });
    this.child = child;

    const stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdoutLines.on('line', (line) => this.handleStdoutLine(line));

    child.stderr.on('data', () => undefined);

    // Writes raced against process exit must not crash the sidecar with an
    // unhandled stream error; callers notice death via close/timeout instead.
    child.stdin.on('error', () => undefined);

    child.on('error', (err) => {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
    });

    child.on('exit', () => {
      stdoutLines.close();
      this.child = null;
      this.fireOnCloseOnce();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (!child || this.closed || hasExited(child)) return;

    if ('method' in message && message.method === 'tools/call' && 'id' in message) {
      this.pendingToolCalls?.add(message.id);
    }
    const drained = child.stdin.write(`${JSON.stringify(message)}\n`);
    if (!drained) {
      // A dead child never drains; settle on exit/stdin close so callers of
      // send cannot park forever inside a tool call.
      await new Promise<void>((resolve) => {
        const settle = () => {
          child.stdin.off('drain', settle);
          child.stdin.off('close', settle);
          child.stdin.off('error', settle);
          child.off('exit', settle);
          resolve();
        };
        child.stdin.once('drain', settle);
        child.stdin.once('close', settle);
        child.stdin.once('error', settle);
        child.once('exit', settle);
      });
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.runClose();
    return this.closePromise;
  }

  private async runClose(): Promise<void> {
    this.closed = true;

    // An already-exited server has nothing to finalize: its streams are dead
    // and no 'exit' event will ever arrive to resolve a wait.
    const child = this.child;
    if (!child?.pid || hasExited(child)) {
      this.child = null;
      this.fireOnCloseOnce();
      return;
    }

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

    // MCP lifecycle order: end stdin so the server can shut down cleanly,
    // then enforce termination after a bounded wait.
    const cancelled = Array.from(this.pendingToolCalls ?? [], requestId => JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId },
    }) + '\n').join('');
    child.stdin.end(cancelled);

    async function waitForExit(timeoutMs: number): Promise<boolean> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          exited.then(() => true),
          new Promise<false>(resolve => { timer = setTimeout(resolve, timeoutMs, false); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }

    if (!await waitForExit(this.gracefulCloseTimeoutMs)) {
      try {
        // agent-desktop receives the MCP cancellation above and has its own
        // grace period to reap the command child before this fallback.
        child.kill(this.pendingToolCalls ? 'SIGKILL' : 'SIGTERM');
      } catch (err) {
        logSidecar('failed to terminate managed stdio server', err);
      }
      const stopped = await waitForExit(this.gracefulCloseTimeoutMs);
      if (!stopped && this.pendingToolCalls) throw new Error('The Computer Use process did not stop.');
    }

    this.fireOnCloseOnce();
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line) as JSONRPCMessage;
      if ('id' in message && !('method' in message)) this.pendingToolCalls?.delete(message.id);
      this.onmessage?.(message);
    } catch {
      const sanitized = this.redact(line);
      const truncated = sanitized.length > 512 ? `${sanitized.slice(0, 512)}...` : sanitized;
      this.onerror?.(new Error(`Managed stdio server emitted malformed JSONL: ${truncated}`));
    }
  }

  private redact(text: string): string {
    let output = text;
    for (const secret of this.redactValues) {
      output = output.split(secret).join('[redacted]');
    }
    return output;
  }

  private fireOnCloseOnce(): void {
    if (this.onCloseFired) return;
    this.onCloseFired = true;
    this.onclose?.();
  }
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
