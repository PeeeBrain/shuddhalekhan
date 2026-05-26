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
}

export class JsonlProcessManager<TReceive, TSend> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutLines: Interface | null = null;

  constructor(private readonly handlers: JsonlProcessManagerHandlers<TReceive>) {}

  get isRunning(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  start(launch: JsonlProcessLaunch): void {
    if (this.isRunning) return;

    this.child = spawn(launch.command, launch.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: launch.env,
    });

    this.stdoutLines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });

    this.stdoutLines.on('line', (line) => this.handleStdoutLine(line));
    this.child.stderr.on('data', (chunk) => {
      console.error(`[jsonl-process] ${String(chunk).trimEnd()}`);
    });
    this.child.on('exit', (code, signal) => {
      this.stdoutLines?.close();
      this.stdoutLines = null;
      this.child = null;
      this.handlers.onExit?.(code, signal);
    });
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
