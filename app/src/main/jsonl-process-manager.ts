import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, type Interface } from 'readline';

export interface JsonlProcessLaunch {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface JsonlProcessManagerHandlers<TReceive> {
  onMessage: (message: TReceive) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onMalformedMessage?: (line: string, error: unknown) => void;
  onSpawn?: () => void;
}

export class JsonlProcessManager<TReceive, TSend> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutLines: Interface | null = null;

  constructor(private readonly handlers: JsonlProcessManagerHandlers<TReceive>) {}

  get isRunning(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  getChildPid(): number | null {
    return this.child?.pid ?? null;
  }

  start(launch: JsonlProcessLaunch): void {
    if (this.isRunning) return;

    // Wire against a local reference: handlers (onSpawn/onExit) may tear the
    // manager down synchronously before start() finishes.
    const child = spawn(launch.command, launch.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: launch.env,
    });

    const stdoutLines = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    stdoutLines.on('line', (line) => this.handleStdoutLine(line));
    child.stderr.on('data', (chunk) => {
      console.error(`[jsonl-process] ${String(chunk).trimEnd()}`);
    });
    child.on('exit', (code, signal) => {
      stdoutLines.close();
      if (this.child === child) {
        this.child = null;
        this.stdoutLines = null;
      }
      this.handlers.onExit?.(code, signal);
    });

    this.stdoutLines = stdoutLines;
    this.child = child;
    this.handlers.onSpawn?.();
  }

  send(message: TSend): void {
    if (!this.child || this.child.killed) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  stop(): void {
    this.stdoutLines?.close();
    this.stdoutLines = null;
    this.child?.kill();
    this.child = null;
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) return;

    try {
      this.handlers.onMessage(JSON.parse(line) as TReceive);
    } catch (error) {
      this.handlers.onMalformedMessage?.(line, error);
    }
  }
}
