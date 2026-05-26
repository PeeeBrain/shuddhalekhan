import { app } from 'electron';
import { join } from 'path';
import type { AppConfig } from '../types/ipc';
import type { ElectronToSidecarMessage, SidecarEvent } from '../agent/protocol';
import { JsonlProcessManager, type JsonlProcessLaunch } from './jsonl-process-manager';

type SidecarEventHandler = (event: SidecarEvent) => void;

type ProcessManager = Pick<JsonlProcessManager<SidecarEvent, ElectronToSidecarMessage>, 'isRunning' | 'start' | 'send' | 'stop'>;

export class AgentSidecarManager {
  private readonly process: ProcessManager;

  constructor(private readonly onEvent: SidecarEventHandler, process?: ProcessManager) {
    this.process = process ?? new JsonlProcessManager<SidecarEvent, ElectronToSidecarMessage>({
      onMessage: (event) => this.onEvent(event),
      onMalformedMessage: (_line, err) => {
        console.error('Agent sidecar emitted malformed JSONL:', err);
      },
    });
  }

  start(config: AppConfig): void {
    if (!this.process.isRunning) {
      this.process.start(this.getSidecarLaunch());
    }

    this.send({
      type: 'config:update',
      config,
    });
  }

  startRun(agentRunId: string, transcript: string, config: AppConfig): void {
    this.start(config);
    this.send({
      type: 'agent:start',
      agentRunId,
      transcript,
    });
  }

  cancelRun(agentRunId: string): void {
    this.send({
      type: 'agent:cancel',
      agentRunId,
    });
  }

  stop(): void {
    this.process.stop();
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

  private send(message: ElectronToSidecarMessage): void {
    this.process.send(message);
  }

  private getSidecarLaunch(): JsonlProcessLaunch {
    if (app.isPackaged) {
      return {
        command: process.execPath,
        args: [join(process.resourcesPath, 'app.asar', 'out', 'agent', 'index.js')],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          SHUDDHALEKHAN_AUDIT_DIR: app.getPath('userData'),
        },
      };
    }

    return {
      command: getBunCommand(),
      args: [join(app.getAppPath(), 'src', 'agent', 'index.ts')],
      env: {
        ...process.env,
        SHUDDHALEKHAN_AUDIT_DIR: app.getPath('userData'),
      },
    };
  }
}

function getBunCommand(): string {
  return process.platform === 'win32' ? 'bun.exe' : 'bun';
}
