import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import type { JSONRPCMessage } from '@ai-sdk/mcp';
import { logSidecar } from './protocol';

export type ManagedStdioLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type ManagedStdioOptions = {
  launch: ManagedStdioLaunch;
  gracefulCloseTimeoutMs?: number;
  stderrMaxBytes?: number;
  redactValues?: string[];
};

const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 5000;
const DEFAULT_STDERR_MAX_BYTES = 8192;

// Application-owned stdio transport for managed MCP servers: hidden shell-free
// launch, piped stdio, bounded redacted stderr, and a graceful shutdown that
// ends stdin first and enforces termination only after a bounded wait.
export class ManagedStdioMcpTransport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly launch: ManagedStdioLaunch;
  private readonly gracefulCloseTimeoutMs: number;
  private readonly stderrMaxBytes: number;
  private readonly redactValues: string[];
  private stderrBuffer = '';
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private onCloseFired = false;
  constructor(options: ManagedStdioOptions) {
    this.launch = options.launch;
    this.gracefulCloseTimeoutMs =
      options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS;
    this.stderrMaxBytes = options.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES;
    this.redactValues = (options.redactValues ?? []).filter((value) => value.length > 0);
  }

  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  getRecentStderr(): string {
    return this.redact(this.stderrBuffer);
  }

  async start(): Promise<void> {
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

    child.stderr.on('data', (chunk) => this.appendStderr(String(chunk)));

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
    if (!child || hasExited(child)) {
      this.child = null;
      this.fireOnCloseOnce();
      return;
    }

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

    // MCP lifecycle order: end stdin so the server can shut down cleanly,
    // then enforce termination after a bounded wait.
    child.stdin.end();

    const gracefulTimeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), this.gracefulCloseTimeoutMs)
    );
    const outcome = await Promise.race([exited.then(() => 'exited' as const), gracefulTimeout]);

    if (outcome === 'timeout') {
      try {
        child.kill();
      } catch (err) {
        logSidecar('failed to terminate managed stdio server', err);
      }
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, this.gracefulCloseTimeoutMs)),
      ]);
    }

    this.fireOnCloseOnce();
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) return;

    try {
      this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
    } catch {
      const sanitized = this.redact(line);
      const truncated = sanitized.length > 512 ? `${sanitized.slice(0, 512)}...` : sanitized;
      this.onerror?.(new Error(`Managed stdio server emitted malformed JSONL: ${truncated}`));
    }
  }

  private appendStderr(chunk: string): void {
    // Retain raw text with a byte margin so secrets split across chunk
    // boundaries still fall inside the window; redaction happens at read time.
    const marginBytes = Math.max(...this.redactValues.map((value) => Buffer.byteLength(value)), 0);
    this.stderrBuffer = truncateTail(this.stderrBuffer + chunk, this.stderrMaxBytes + marginBytes);
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

function truncateTail(text: string, maxBytes: number): string {
  const buffered = Buffer.from(text, 'utf8');
  if (buffered.byteLength <= maxBytes) return text;
  return buffered.subarray(buffered.byteLength - maxBytes).toString('utf8');
}
