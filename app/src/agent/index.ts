import { APPROVAL_TIMEOUT_MESSAGE } from '@shuddhalekhan/shared/agent-prompt';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { logSidecar, parseElectronMessage, writeJsonLine } from './protocol';
import { runAgent } from './runtime';
import { testAgentProvider } from './provider-test';
import { failedProviderTest } from '../shared/agent-provider';
import type { ModelMessage } from 'ai';
import type { AppConfig } from '../types/ipc';
import type { ApprovalDecisionMessage } from './protocol';
import type { ToolApprovalDecision, ToolApprovalRequest } from './runtime';
import { AgentAuditStore } from './audit';
import { McpRegistry } from './mcp-registry';
import { AgentMemoryCommitter } from './memory-committer';
import { RUN_SETTLE_TIMEOUT_MS, SIDECAR_EXIT_TIMEOUT_MS } from '../shared/agent-timeouts';
import type { AgentRunContext } from '../shared/agent-context';
import {
  AisdkMcpClientFactory,
  SidecarOAuthRedirectFactory,
  StdoutSidecarMessageTransporter,
} from './mcp-registry-adapters';

let config: AppConfig | null = null;
let agentApiKey: string | undefined;
type AgentExecution = {
  agentRunId: string;
  controller: AbortController;
  phase: 'running' | 'completed' | 'failed' | 'cancelled';
};
// The audit run id survives replies; this object identifies just one execution.
let execution: AgentExecution | null = null;
const pendingRuns = new Set<Promise<void>>();
let providerTest: { requestId: string; controller: AbortController } | null = null;
let pendingApproval: PendingApproval | null = null;
let approvalQueue: Promise<void> = Promise.resolve();
let configUpdateQueue: Promise<void> = Promise.resolve();
let shutdownPromise: Promise<void> | null = null;
const auditStore = new AgentAuditStore();
const memoryCommitter = new AgentMemoryCommitter(writeJsonLine);
const oauthRedirectFactory = new SidecarOAuthRedirectFactory();
const mcpRegistry = new McpRegistry({
  mcpClientFactory: new AisdkMcpClientFactory(oauthRedirectFactory),
  oauthFactory: oauthRedirectFactory,
  transporter: new StdoutSidecarMessageTransporter(),
});

// Long enough to return from another app and read the arguments; the run waits, nothing else is blocked.
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** The latest completed run, kept in memory only so the next command can reply to it. */
let lastConversation: { agentRunId: string; provider: string; messages: ModelMessage[] } | null = null;


type PendingApproval = {
  execution: AgentExecution;
  approvalId: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (decision: ToolApprovalDecision) => void;
};

function ownsExecution(run: AgentExecution): boolean {
  return execution === run && run.phase === 'running';
}

function exitWithGroup(): void {
  auditStore.close();
  if (process.platform !== 'win32') {
    try { process.kill(-process.pid, 'SIGKILL'); } catch { /* not a group leader */ }
  }
  process.exit(0);
}

function main(): void {
  writeJsonLine({
    type: 'sidecar:ready',
    protocolVersion: 1,
  });

  logSidecar('ready');

  const input = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  // Electron gone (or stopping us): close MCP clients, then exit so no orphan
  // outlives the app. On POSIX we lead our own process group (detached spawn)
  // and Electron may not be alive to kill it, so the last step kills the group:
  // any MCP server or tool process that ignored EOF dies with us.
  input.on('close', () => {
    setTimeout(exitWithGroup, SIDECAR_EXIT_TIMEOUT_MS).unref();
    void beginShutdown(false).finally(exitWithGroup);
  });

  input.on('line', (line) => {
    try {
      handleLine(line);
    } catch (err) {
      logSidecar('failed to handle protocol line', err);
    }
  });
}

function handleLine(line: string): void {
  if (!line.trim()) return;

  const message = parseElectronMessage(line);
  if (!message) {
    logSidecar('ignored unknown protocol message');
    return;
  }
  if (shutdownPromise && message.type !== 'sidecar:shutdown') return;

  switch (message.type) {
    case 'provider:test': {
      if (execution?.phase === 'running' || providerTest) {
        writeJsonLine({ type: 'provider:test-result', requestId: message.requestId, result: failedProviderTest({
          kind: 'busy', message: 'Agent Mode is busy.', action: 'Wait for the active run or model test to finish.',
        }) });
        break;
      }
      const controller = new AbortController();
      const request = { requestId: message.requestId, controller };
      providerTest = request;
      void testAgentProvider(message.provider, controller.signal, message.apiKey)
        .then(result => writeJsonLine({ type: 'provider:test-result', requestId: message.requestId, result }))
        .catch(() => writeJsonLine({ type: 'provider:test-result', requestId: message.requestId, result: failedProviderTest({
          kind: 'provider', message: 'The model test failed unexpectedly.', action: 'Retry the model test.',
        }) }))
        .finally(() => { if (providerTest === request) providerTest = null; });
      break;
    }
    case 'provider:cancel-test':
      if (providerTest?.requestId === message.requestId) providerTest.controller.abort();
      break;
    case 'config:update':
      // A disabled agent keeps nothing.
      if (!message.config.agent.enabled) lastConversation = null;
      config = message.config;
      agentApiKey = message.agentApiKey;
      logSidecar('received config update');
      configUpdateQueue = configUpdateQueue.then(() => mcpRegistry.updateConfig(message.config));
      break;
    case 'agent:start':
      {
        const run = handleAgentStart(message.agentRunId, message.transcript, message.context, message.continueFrom);
        pendingRuns.add(run);
        void run.finally(() => pendingRuns.delete(run));
      }
      break;
    case 'memory:commit-result':
      memoryCommitter.accept(message);
      break;
    case 'agent:cancel':
      handleAgentCancel(message.agentRunId);
      break;
    case 'approval:decision':
      handleApprovalDecision(message);
      break;
    case 'mcp:test-server':
      configUpdateQueue = configUpdateQueue
        .then(() => mcpRegistry.testServer(message.serverId))
        .catch((err) => logSidecar('mcp test-server failed', err));
      break;
    case 'sidecar:shutdown':
      void beginShutdown(true);
      break;
  }
}

async function handleAgentStart(agentRunId: string, transcript: string, context?: AgentRunContext, continueFrom?: string): Promise<void> {
  providerTest?.controller.abort();
  // Taken once: a failed or cancelled reply ends the conversation instead of leaving it half-updated.
  // Never sent to another provider, even if the provider changed while the answered run was still going.
  const provider = JSON.stringify(config?.agent.provider);
  const history = continueFrom && lastConversation?.agentRunId === continueFrom && lastConversation.provider === provider
    ? lastConversation.messages : [];
  lastConversation = null;
  const previous = execution;
  if (previous?.phase === 'running') {
    previous.phase = 'cancelled';
    auditStore.record(previous.agentRunId, 'run_interrupted');
    previous.controller.abort();
    rejectPendingApproval(previous, 'Agent run was interrupted.');
    writeJsonLine({ type: 'agent:cancelled', agentRunId: previous.agentRunId });
  }

  const run: AgentExecution = { agentRunId, controller: new AbortController(), phase: 'running' };
  execution = run;
  const runController = run.controller;

  const currentConfig = config;
  const currentAgentApiKey = agentApiKey;
  if (!currentConfig) {
    writeJsonLine({ type: 'agent:failed', agentRunId, error: 'No config available' });
    run.phase = 'failed';
    return;
  }

  try {
    await configUpdateQueue;
    if (!ownsExecution(run) || runController.signal.aborted) return;
    const availability = await mcpRegistry.settle(5000);
    if (!ownsExecution(run) || runController.signal.aborted) return;
    if (availability.connected < availability.enabled) {
      const status = `Some Agent tools are unavailable. Connected to ${availability.connected} of ${availability.enabled} MCP servers.`;
      auditStore.record(agentRunId, 'status', { status });
      writeJsonLine({ type: 'agent:status', agentRunId, status });
    }
    const toolSnapshot = mcpRegistry.createRunSnapshot(
      (eventType, payload) => auditStore.record(agentRunId, eventType, payload),
      (tool) => {
        if (!ownsExecution(run)) return;
        const status = `Using tool: ${tool.serverId}.${tool.toolName}`;
        auditStore.record(agentRunId, 'status', { status });
        writeJsonLine({ type: 'agent:status', agentRunId, status });
      }
    );

    try {
      const messages = await runAgent(agentRunId, transcript, currentConfig, toolSnapshot.tools, runController.signal, {
        onStatus: (status) => {
          if (!ownsExecution(run)) return;
          auditStore.record(agentRunId, 'status', { status });
          writeJsonLine({ type: 'agent:status', agentRunId, status });
        },
        onSteps: (steps) => {
          if (!ownsExecution(run)) return;
          writeJsonLine({ type: 'agent:steps', agentRunId, steps });
        },
        onCompleted: (response, toolSummary, steps) => {
          if (!ownsExecution(run)) return;
          run.phase = 'completed';
          writeJsonLine({ type: 'agent:completed', agentRunId, response, toolSummary, steps });
        },
        onFailed: (error) => {
          if (!ownsExecution(run)) return;
          run.phase = 'failed';
          writeJsonLine({ type: 'agent:failed', agentRunId, error });
        },
        onCancelled: () => {
          if (!ownsExecution(run)) return;
          run.phase = 'cancelled';
          rejectPendingApproval(run, 'Agent run was interrupted.');
          writeJsonLine({ type: 'agent:cancelled', agentRunId });
        },
        requestToolApproval: (request) => requestToolApproval(run, request),
        onAudit: (eventType, payload) => {
          if (ownsExecution(run)) auditStore.record(agentRunId, eventType, payload);
        },
        commitMemory: (revision, updates) => memoryCommitter.request(agentRunId, revision, updates, runController.signal),
        shouldLearnMemory: () => config?.agent.memoryEnabled === true && ownsExecution(run),
        onMemoryStatus: status => {
          if (ownsExecution(run)) writeJsonLine({ type: 'memory:status', agentRunId, status });
        },
      }, currentAgentApiKey, context, history);
      // A newer run may have started while this one finished; only the latest answer can be replied to.
      if (messages && execution === run && run.phase === 'completed' && config?.agent.enabled) {
        lastConversation = { agentRunId, provider: JSON.stringify(currentConfig.agent.provider), messages };
      }
    } finally {
      await toolSnapshot.close();
    }
  } catch (err) {
    if (!ownsExecution(run)) return;
    logSidecar('unhandled agent start error', err);
    writeJsonLine({
      type: 'agent:failed',
      agentRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    run.phase = 'failed';
  }
}

function handleAgentCancel(agentRunId: string): void {
  const run = execution;
  if (run?.agentRunId === agentRunId && ownsExecution(run)) {
    run.phase = 'cancelled';
    auditStore.record(agentRunId, 'run_interrupted');
    run.controller.abort();
    rejectPendingApproval(run, 'Agent run was interrupted.');
  }
  writeJsonLine({
    type: 'agent:cancelled',
    agentRunId,
  });
}

async function requestToolApproval(run: AgentExecution, request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
  const { agentRunId } = run;
  const previousQueue = approvalQueue;
  let releaseQueue: () => void = () => undefined;
  approvalQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });

  await previousQueue;

  if (!ownsExecution(run)) {
    releaseQueue();
    return { approved: false, message: 'Rejected: agent run is no longer active.' };
  }

  return new Promise<ToolApprovalDecision>((resolve) => {
    const approvalId = randomUUID();
    const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString();
    const finish = (decision: ToolApprovalDecision) => {
      if (pendingApproval?.approvalId === approvalId) {
        clearTimeout(pendingApproval.timeout);
        pendingApproval = null;
      }
      releaseQueue();
      auditStore.record(agentRunId, 'approval_decision', {
        approvalId,
        serverId: request.serverId,
        toolName: request.toolName,
        modelToolName: request.modelToolName,
        approved: decision.approved,
        message: decision.approved ? undefined : decision.message,
      });
      resolve(decision);
    };

    const timeout = setTimeout(() => {
      writeJsonLine({ type: 'agent:status', agentRunId, status: 'Tool approval expired.' });
      finish({ approved: false, message: APPROVAL_TIMEOUT_MESSAGE });
    }, APPROVAL_TIMEOUT_MS);

    pendingApproval = {
      execution: run,
      approvalId,
      timeout,
      resolve: finish,
    };

    auditStore.record(agentRunId, 'approval_requested', {
      approvalId,
      serverId: request.serverId,
      toolName: request.toolName,
      modelToolName: request.modelToolName,
      arguments: request.arguments,
      expiresAt,
    });

    writeJsonLine({
      type: 'approval:requested',
      agentRunId,
      approvalId,
      serverId: request.serverId,
      toolName: request.toolName,
      modelToolName: request.modelToolName,
      arguments: request.arguments,
      expiresAt,
    });
  });
}

function handleApprovalDecision(message: ApprovalDecisionMessage): void {
  if (
    !pendingApproval ||
    !ownsExecution(pendingApproval.execution) ||
    pendingApproval.execution.agentRunId !== message.agentRunId ||
    pendingApproval.approvalId !== message.approvalId
  ) {
    logSidecar('ignored stale approval decision');
    return;
  }

  if (message.decision === 'approved') {
    pendingApproval.resolve({ approved: true });
    return;
  }

  pendingApproval.resolve({
    approved: false,
    message: message.message?.trim() || 'Rejected: user denied tool approval.',
  });
}

function rejectPendingApproval(run: AgentExecution, message: string): void {
  if (!pendingApproval || pendingApproval.execution !== run) return;
  pendingApproval.resolve({ approved: false, message });
}

async function shutdown(): Promise<void> {
  providerTest?.controller.abort();
  const run = execution;
  if (run && ownsExecution(run)) {
    run.controller.abort();
    rejectPendingApproval(run, 'Agent run was interrupted because the sidecar is shutting down.');
  }
  await configUpdateQueue.catch(() => undefined);
  // The aborted run records its own interruption; a tool that ignores the abort must not hold MCP cleanup hostage.
  const runningId = execution?.phase === 'running' ? execution.agentRunId : null;
  const settled = await Promise.race([
    Promise.allSettled(pendingRuns).then(() => true),
    new Promise<false>((resolve) => setTimeout(resolve, RUN_SETTLE_TIMEOUT_MS, false).unref()),
  ]);
  if (!settled && runningId) auditStore.record(runningId, 'run_interrupted', { reason: 'sidecar_shutdown' });
  await mcpRegistry.close();
  auditStore.close();
}

function beginShutdown(acknowledge: boolean): Promise<void> {
  // A failed registry close must not become an unhandled rejection nor withhold
  // the acknowledgement: main force-terminates the generation after its wait.
  if (!shutdownPromise) {
    shutdownPromise = shutdown().catch((err) => {
      logSidecar('sidecar shutdown failed', err);
    });
  }
  if (!acknowledge) return shutdownPromise;
  return shutdownPromise.then(() => {
    writeJsonLine({ type: 'sidecar:shutdown-complete' });
  });
}

process.once('SIGINT', () => {
  void beginShutdown(false).finally(exitWithGroup);
});
process.once('SIGTERM', () => {
  void beginShutdown(false).finally(exitWithGroup);
});

main();
