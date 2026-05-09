import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, type Interface } from 'readline';
import { randomUUID } from 'crypto';
import { join } from 'path';
import type { AppConfig } from '../types/ipc';
import type { ElectronToSidecarMessage, SidecarEvent } from '../agent/protocol';

type SidecarEventHandler = (event: SidecarEvent) => void;
type SidecarLaunch = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

export class AgentSidecarManager {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutLines: Interface | null = null;
  private activeAgentRunId: string | null = null;

  constructor(private readonly onEvent: SidecarEventHandler) {}

  start(config: AppConfig): void {
    if (this.child && !this.child.killed) {
      this.send({
        type: 'config:update',
        config,
      });
      return;
    }

    const launch = this.getSidecarLaunch();
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
      console.error(`[agent-sidecar] ${String(chunk).trimEnd()}`);
    });
    this.child.on('exit', () => {
      this.child = null;
      this.stdoutLines?.close();
      this.stdoutLines = null;
      this.activeAgentRunId = null;
    });

    this.send({
      type: 'config:update',
      config,
    });
  }

  startRun(transcript: string, config: AppConfig): string {
    if (this.activeAgentRunId) {
      this.cancelRun(this.activeAgentRunId);
    }

    this.start(config);

    const agentRunId = randomUUID();
    this.activeAgentRunId = agentRunId;
    this.send({
      type: 'agent:start',
      agentRunId,
      transcript,
    });

    return agentRunId;
  }

  cancelActiveRun(): void {
    if (!this.activeAgentRunId) return;
    this.cancelRun(this.activeAgentRunId);
  }

  stop(): void {
    this.cancelActiveRun();
    this.stdoutLines?.close();
    this.stdoutLines = null;
    this.child?.kill();
    this.child = null;
    this.activeAgentRunId = null;
  }

  getActiveAgentRunId(): string | null {
    return this.activeAgentRunId;
  }

  sendApprovalDecision(
    agentRunId: string,
    approvalId: string,
    decision: 'approved' | 'denied',
    message?: string
  ): void {
    this.send({
      type: 'approval:decision',
      agentRunId,
      approvalId,
      decision,
      message,
    });
  }

  private cancelRun(agentRunId: string): void {
    this.send({
      type: 'agent:cancel',
      agentRunId,
    });
  }

  private send(message: ElectronToSidecarMessage): void {
    if (!this.child || this.child.killed) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) return;

    let event: SidecarEvent;
    try {
      event = JSON.parse(line) as SidecarEvent;
    } catch (err) {
      console.error('Agent sidecar emitted malformed JSONL:', err);
      return;
    }

    if ('agentRunId' in event && event.agentRunId !== this.activeAgentRunId) {
      return;
    }

    if (event.type === 'agent:completed' || event.type === 'agent:failed' || event.type === 'agent:cancelled') {
      this.activeAgentRunId = null;
    }

    this.onEvent(event);
  }

  private getSidecarLaunch(): SidecarLaunch {
    if (app.isPackaged) {
      return {
        command: process.execPath,
        args: [join(process.resourcesPath, 'app.asar', 'out', 'agent', 'index.js')],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
        },
      };
    }

    return {
      command: getBunCommand(),
      args: [join(app.getAppPath(), 'src', 'agent', 'index.ts')],
    };
  }
}

function getBunCommand(): string {
  return process.platform === 'win32' ? 'bun.exe' : 'bun';
}
