import { app } from 'electron';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import type { AgentProviderConfig, AgentProviderTestResult, AppConfig } from '../types/ipc';
import { failedProviderTest } from '../shared/agent-provider';
import { providerTestCancelled, providerTestTimedOut } from '../shared/agent-provider-test';
import { PROVIDER_TEST_RESPONSE_TIMEOUT_MS, SIDECAR_SHUTDOWN_TIMEOUT_MS } from '../shared/agent-timeouts';
import type { ElectronToSidecarMessage, SidecarEvent } from '../agent/protocol';
import { JsonlProcessManager, type JsonlProcessLaunch } from './jsonl-process-manager';
import { getPersistentStoreDirectory } from './store-path';
import { resolveAuditDbPath } from '../shared/audit-db';
import { createJobObjectPort, type JobObjectPort } from './native/job-object';
import type { AgentMemoryCommitResult, AgentRunContext } from '../shared/agent-context';

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
  job: unknown;
  state:
    | { kind: 'starting'; pending: ElectronToSidecarMessage[] }
    | { kind: 'ready' }
    | { kind: 'stopping'; promise: Promise<void>; finish: () => void }
    | { kind: 'stopped' };
};

export type SidecarManagerDeps = {
  jobPort?: JobObjectPort;
  shutdownTimeoutMs?: number;
  scheduleTimeout?: (fn: () => void, ms: number) => () => void;
  onLifecycleError?: (error: SidecarLifecycleError) => void;
  onGenerationExit?: () => void;
};


export class AgentSidecarManager {
  private providerTest: { requestId: string; resolve: (result: AgentProviderTestResult) => void; cancelTimeout: () => void } | null = null;
  private generation: Generation | null = null;
  private process: GenerationProcess | null = null;
  private readonly jobPort: JobObjectPort;
  private readonly shutdownTimeoutMs: number;
  private readonly scheduleTimeout: (fn: () => void, ms: number) => () => void;
  private readonly onLifecycleError?: (error: SidecarLifecycleError) => void;
  private readonly onGenerationExit?: () => void;

  constructor(
    private readonly onEvent: SidecarEventHandler,
    deps: SidecarManagerDeps = {},
  ) {
    this.jobPort = deps.jobPort ?? createJobObjectPort();
    this.shutdownTimeoutMs = deps.shutdownTimeoutMs ?? SIDECAR_SHUTDOWN_TIMEOUT_MS;
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

  startRun(agentRunId: string, transcript: string, config: AppConfig, agentApiKey?: string, context?: AgentRunContext, continueFrom?: string): void {
    this.cancelProviderTest();
    this.start(config, agentApiKey);
    this.sendOrQueue({
      type: 'agent:start',
      agentRunId,
      transcript,
      ...(context ? { context } : {}),
      ...(continueFrom ? { continueFrom } : {}),
    });
  }

  cancelRun(agentRunId: string): void {
    this.sendOrQueue({
      type: 'agent:cancel',
      agentRunId,
    });
  }

  sendMemoryResult(agentRunId: string, requestId: string, result: AgentMemoryCommitResult): void {
    this.sendOrQueue({ type: 'memory:commit-result', agentRunId, requestId, result });
  }

  stop(): Promise<void> {
    this.cancelProviderTest();
    const generation = this.generation;
    if (!generation) return Promise.resolve();
    if (generation.state.kind === 'stopping') return generation.state.promise;
    if (generation.state.kind === 'stopped') return Promise.resolve();

    const wasReady = generation.state.kind === 'ready';
    let resolveStopped: () => void = () => undefined;
    const promise = new Promise<void>(resolve => { resolveStopped = resolve; })
      .then(() => this.teardownGeneration(generation));
    const cancelTimer = this.scheduleTimeout(resolveStopped, this.shutdownTimeoutMs);
    generation.state = { kind: 'stopping', promise, finish: () => {
      cancelTimer();
      resolveStopped();
    } };
    if (wasReady) this.write({ type: 'sidecar:shutdown' });
    if (!this.process?.isRunning) generation.state.finish();
    return promise;
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

  testProvider(provider: AgentProviderConfig, apiKey?: string): Promise<AgentProviderTestResult> {
    if (this.providerTest) return Promise.resolve(failedProviderTest({
      kind: 'busy', message: 'A model test is already running.', action: 'Wait for it to finish or cancel it.',
    }));
    this.ensureGeneration();
    if (!this.generation) return Promise.resolve(failedProviderTest({
      kind: 'provider', message: 'The Agent sidecar could not start.', action: 'Check runtime availability and try again.',
    }));
    const requestId = randomUUID();
    return new Promise(resolve => {
      const cancelTimeout = this.scheduleTimeout(() => {
        this.cancelProviderTestRequest(requestId);
        this.finishProviderTest(failedProviderTest(providerTestTimedOut));
      }, PROVIDER_TEST_RESPONSE_TIMEOUT_MS);
      this.providerTest = { requestId, resolve, cancelTimeout };
      this.sendOrQueue({ type: 'provider:test', requestId, provider, ...(apiKey ? { apiKey } : {}) });
    });
  }

  cancelProviderTest(): void {
    if (!this.providerTest) return;
    this.cancelProviderTestRequest(this.providerTest.requestId);
    this.finishProviderTest(failedProviderTest(providerTestCancelled));
  }

  private cancelProviderTestRequest(requestId: string): void {
    if (this.generation?.state.kind === 'starting') {
      this.generation.state.pending = this.generation.state.pending.filter(message => message.type !== 'provider:test' || message.requestId !== requestId);
    } else {
      this.sendOrQueue({ type: 'provider:cancel-test', requestId });
    }
  }

  private finishProviderTest(result: AgentProviderTestResult): void {
    const pending = this.providerTest;
    if (!pending) return;
    this.providerTest = null;
    pending.cancelTimeout();
    pending.resolve(result);
  }

  /** Point-update the sidecar config, then reconnect only the named MCP server. */
  testMcpServer(config: AppConfig, agentApiKey: string | undefined, serverId: string): void {
    this.start(config, agentApiKey);
    this.sendOrQueue({
      type: 'mcp:test-server',
      serverId,
    });
  }

  private ensureGeneration(): void {
    // A generation that is still gracefully stopping cannot accept traffic.
    // Replace it immediately so an explicit start always yields a usable
    // runtime; teardown also settles its outstanding stop wait.
    if (this.generation?.state.kind === 'stopping') {
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
      job,
      state: { kind: 'starting', pending: [] },
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
          this.onLifecycleError?.({ reason: 'job-assignment-failed', pid: pid ?? -1 });
          process.stop();
          this.teardownGeneration(generation);
          return;
        }
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

    if (event.type === 'provider:test-result') {
      if (event.requestId === this.providerTest?.requestId) this.finishProviderTest(event.result);
      return;
    }

    if (event.type === 'sidecar:ready') {
      const state = generation.state;
      if (state.kind === 'stopping') {
        this.write({ type: 'sidecar:shutdown' });
      } else if (state.kind === 'starting') {
        generation.state = { kind: 'ready' };
        for (const message of state.pending) this.sendOrQueue(message);
      }
    }
    if (event.type === 'sidecar:shutdown-complete' && generation.state.kind === 'stopping') {
      generation.state.finish();
    }
    this.onEvent(event);
  }

  private handleExit(generation: Generation): void {
    if (this.generation !== generation) return;
    if (generation.state.kind !== 'stopping') this.onGenerationExit?.();
    this.teardownGeneration(generation);
  }

  private teardownGeneration(generation: Generation): void {
    if (generation.state.kind === 'stopped') return;
    if (generation.state.kind === 'stopping') generation.state.finish();
    generation.state = { kind: 'stopped' };
    if (this.generation === generation) {
      this.finishProviderTest(failedProviderTest({ kind: 'provider', message: 'The Agent sidecar stopped during the model test.', action: 'Retry the model test.' }));
      this.generation = null;
      this.process?.stop();
      this.process = null;
    }

    // The job kill is the descendant-tree backstop; the direct kill covers a
    // failed job assignment or a job API failure.
    this.jobPort.terminate(generation.job);
  }

  private sendOrQueue(message: ElectronToSidecarMessage): void {
    const generation = this.generation;
    if (!generation) return;
    switch (generation.state.kind) {
      case 'starting':
        generation.state.pending.push(message);
        return;
      case 'ready':
        this.write(message);
        return;
      case 'stopping':
      case 'stopped':
        return;
    }
  }

  private write(message: ElectronToSidecarMessage): void {
    this.process?.send(message);
  }

  private getSidecarLaunch(): JsonlProcessLaunch {
    const auditDirectory = dirname(resolveAuditDbPath(getPersistentStoreDirectory()));
    if (app.isPackaged) {
      return {
        command: process.execPath,
        args: [join(process.resourcesPath, 'app.asar', 'out', 'agent', 'index.js')],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          SHUDDHALEKHAN_AUDIT_DIR: auditDirectory,
        },
      };
    }

    return {
      command: getBunCommand(),
      args: [join(app.getAppPath(), 'src', 'agent', 'index.ts')],
      env: {
        ...process.env,
        SHUDDHALEKHAN_AUDIT_DIR: auditDirectory,
      },
    };
  }
}

function getBunCommand(): string {
  return process.platform === 'win32' ? 'bun.exe' : 'bun';
}
