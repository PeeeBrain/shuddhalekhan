import { app } from 'electron';
import { join } from 'path';
import type { AppConfig } from '../types/ipc';
import type { ElectronToSidecarMessage, SidecarEvent } from '../agent/protocol';
import { JsonlProcessManager, type JsonlProcessLaunch } from './jsonl-process-manager';
import { getPersistentStoreDirectory } from './store-path';
import { emitPerformanceMarker } from './performance/marker-collector';
import { KoffiJobObjectPort, type JobObjectPort } from './native/job-object';

export type SidecarLifecycleError =
  | { reason: 'job-creation-failed' }
  | { reason: 'job-assignment-failed'; pid: number };

type SidecarEventHandler = (event: SidecarEvent) => void;

type GenerationProcess = Pick<
  JsonlProcessManager<SidecarEvent, ElectronToSidecarMessage>,
  'isRunning' | 'start' | 'send' | 'stop' | 'getChildPid'
>;

// One generation is one sidecar process plus its containment job. Config and
// run traffic only flows after the sidecar has been assigned to the job and
// has announced readiness. At most one generation is wired at a time, so the
// transport lives on the manager while Generation stays pure lifecycle state.
type Generation = {
  id: number;
  job: unknown;
  ready: boolean;
  stopping: boolean;
  tornDown: boolean;
  pending: ElectronToSidecarMessage[];
  stopPromise?: Promise<void>;
  resolveStop?: () => void;
};

export type SidecarManagerDeps = {
  jobPort?: JobObjectPort;
  shutdownTimeoutMs?: number;
  scheduleTimeout?: (fn: () => void, ms: number) => () => void;
  onLifecycleError?: (error: SidecarLifecycleError) => void;
  onGenerationExit?: () => void;
};

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

export class AgentSidecarManager {
  private generation: Generation | null = null;
  private process: GenerationProcess | null = null;
  private nextGenerationId = 1;
  private readonly jobPort: JobObjectPort;
  private readonly shutdownTimeoutMs: number;
  private readonly scheduleTimeout: (fn: () => void, ms: number) => () => void;
  private readonly onLifecycleError?: (error: SidecarLifecycleError) => void;
  private readonly onGenerationExit?: () => void;

  constructor(
    private readonly onEvent: SidecarEventHandler,
    deps: SidecarManagerDeps = {},
  ) {
    this.jobPort = deps.jobPort ?? new KoffiJobObjectPort();
    this.shutdownTimeoutMs = deps.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.scheduleTimeout =
      deps.scheduleTimeout ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      });
    this.onLifecycleError = deps.onLifecycleError;
    this.onGenerationExit = deps.onGenerationExit;
  }

  start(config: AppConfig, agentApiKey?: string): void {
    this.ensureGeneration();
    this.sendOrQueue({
      type: 'config:update',
      config,
      ...(agentApiKey ? { agentApiKey } : {}),
    });
  }

  startRun(agentRunId: string, transcript: string, config: AppConfig, agentApiKey?: string): void {
    emitPerformanceMarker('agent.run.requested', { agentRunId });
    this.start(config, agentApiKey);
    this.sendOrQueue({
      type: 'agent:start',
      agentRunId,
      transcript,
    });
  }

  cancelRun(agentRunId: string): void {
    this.sendOrQueue({
      type: 'agent:cancel',
      agentRunId,
    });
  }

  stop(): Promise<void> {
    const generation = this.generation;
    if (!generation) return Promise.resolve();
    if (generation.stopPromise) return generation.stopPromise;

    generation.stopPromise = this.stopGeneration(generation);
    return generation.stopPromise;
  }

  private async stopGeneration(generation: Generation): Promise<void> {
    generation.stopping = true;
    if (generation.ready) {
      this.write({ type: 'sidecar:shutdown' });
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        cancelTimer();
        resolve();
      };
      const cancelTimer = this.scheduleTimeout(finish, this.shutdownTimeoutMs);
      generation.resolveStop = finish;
      if (!this.process?.isRunning) finish();
    });

    this.teardownGeneration(generation);
  }

  sendApprovalDecision(
    agentRunId: string,
    approvalId: string,
    decision: 'approved' | 'denied',
    message?: string
  ): void {
    this.sendOrQueue({
      type: 'approval:decision',
      agentRunId,
      approvalId,
      decision,
      message,
    });
  }

  private ensureGeneration(): void {
    // A generation that is still gracefully stopping cannot accept traffic.
    // Replace it immediately so an explicit start always yields a usable
    // runtime; its own stop wait resolves through the tornDown flag.
    if (this.generation?.stopping) {
      this.teardownGeneration(this.generation);
    }
    if (this.generation) return;

    // Fail closed: no job means the sidecar must never launch, because an
    // uncontained sidecar could orphan MCP descendants.
    let job: unknown | null;
    try {
      job = this.jobPort.createKillOnCloseJob();
    } catch (error) {
      console.error('Failed to create the Agent sidecar Job Object:', error);
      this.onLifecycleError?.({ reason: 'job-creation-failed' });
      return;
    }
    if (!job) {
      this.onLifecycleError?.({ reason: 'job-creation-failed' });
      return;
    }

    const generation: Generation = {
      id: this.nextGenerationId++,
      job,
      ready: false,
      stopping: false,
      tornDown: false,
      pending: [],
    };
    this.generation = generation;
    this.process = this.createProcess(generation);
    this.process.start(this.getSidecarLaunch());
  }

  private createProcess(generation: Generation): GenerationProcess {
    const process = new JsonlProcessManager<SidecarEvent, ElectronToSidecarMessage>({
      onSpawn: () => {
        const pid = process.getChildPid();
        let assigned = false;
        if (pid) {
          try {
            assigned = this.jobPort.assign(generation.job, pid);
          } catch (error) {
            console.error('Failed to assign the Agent sidecar to its Job Object:', error);
          }
        }
        if (!assigned) {
          emitPerformanceMarker('sidecar.job.assign-failed');
          this.onLifecycleError?.({ reason: 'job-assignment-failed', pid: pid ?? -1 });
          process.stop();
          this.teardownGeneration(generation);
          return;
        }
        emitPerformanceMarker('sidecar.spawned', { childPid: pid });
      },
      onMessage: (event) => this.handleEvent(generation, event),
      onMalformedMessage: (_line, err) => {
        console.error('Agent sidecar emitted malformed JSONL:', err);
      },
      onExit: () => this.handleExit(generation),
    });
    return process;
  }

  private handleEvent(generation: Generation, event: SidecarEvent): void {
    if (this.generation !== generation) return;

    if (event.type === 'sidecar:ready') {
      generation.ready = true;
      if (generation.stopping) {
        generation.pending = [];
        this.write({ type: 'sidecar:shutdown' });
      } else {
        this.flushPending(generation);
      }
    }
    if (event.type === 'sidecar:shutdown-complete') {
      generation.resolveStop?.();
    }
    this.onEvent(event);
  }

  private handleExit(generation: Generation): void {
    if (this.generation !== generation) return;
    if (!generation.stopping) this.onGenerationExit?.();
    this.teardownGeneration(generation);
  }

  private teardownGeneration(generation: Generation): void {
    if (generation.tornDown) return;
    generation.tornDown = true;
    generation.stopping = true;
    generation.pending = [];
    if (this.generation === generation) {
      this.generation = null;
      this.process?.stop();
      this.process = null;
    }
    generation.resolveStop?.();

    // The job kill is the descendant-tree backstop; the direct kill covers a
    // failed job assignment or a job API failure.
    this.jobPort.terminate(generation.job);
  }

  private sendOrQueue(message: ElectronToSidecarMessage): void {
    const generation = this.generation;
    if (!generation || generation.stopping) return;

    if (!generation.ready) {
      generation.pending.push(message);
      return;
    }
    this.write(message);
  }

  private flushPending(generation: Generation): void {
    for (const message of generation.pending.splice(0)) {
      this.write(message);
    }
  }

  private write(message: ElectronToSidecarMessage): void {
    this.process?.send(message);
    if (message.type === 'config:update') {
      emitPerformanceMarker('sidecar.config.sent');
    }
  }

  private getSidecarLaunch(): JsonlProcessLaunch {
    if (app.isPackaged) {
      return {
        command: process.execPath,
        args: [join(process.resourcesPath, 'app.asar', 'out', 'agent', 'index.js')],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          SHUDDHALEKHAN_AUDIT_DIR: getPersistentStoreDirectory(),
        },
      };
    }

    return {
      command: getBunCommand(),
      args: [join(app.getAppPath(), 'src', 'agent', 'index.ts')],
      env: {
        ...process.env,
        SHUDDHALEKHAN_AUDIT_DIR: getPersistentStoreDirectory(),
      },
    };
  }
}

function getBunCommand(): string {
  return process.platform === 'win32' ? 'bun.exe' : 'bun';
}
