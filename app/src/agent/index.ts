import { COMPUTER_USE_SOURCE_ID, COMPUTER_USE_TOOLS, computerUseToolPolicy } from '../shared/computer-use';
import { createComputerUseRun } from './computer-use';
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
let computerUseExecutable: string | undefined;
const computerUseRuns = new Set<ReturnType<typeof createComputerUseRun>>();

async function closeComputerUseRuns(): Promise<void> {
  await Promise.all([...computerUseRuns].map(run => run.close()));
}
type AgentExecution = {
  agentRunId: string;
  controller: AbortController;
  audit: ReturnType<AgentAuditStore['forExecution']>;
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
let lastConversation: { agentRunId: string; provider: string; messages: ModelMessage[]; usedComputerUse: boolean } | null = null;


type PendingApproval = {
  execution: AgentExecution;
  approvalId: string;
  serverId: string;
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
    case 'config:update': {
      // A disabled agent keeps nothing.
      if (!message.config.agent.enabled) lastConversation = null;
      const previousExecutable = computerUseExecutable;
      const previousComputerUse = config?.agent.computerUse;
      config = message.config;
      computerUseExecutable = config.agent.enabled && config.agent.computerUse?.enabled
        ? message.computerUseExecutable : undefined;
      // An action already running without asking must stop once it would have to ask.
      const lostAlwaysAllow = COMPUTER_USE_TOOLS.some(({ name }) =>
        computerUseToolPolicy(previousComputerUse, name) === 'alwaysAllow'
        && computerUseToolPolicy(message.config.agent.computerUse, name) !== 'alwaysAllow');
      if (computerUseExecutable !== previousExecutable || lostAlwaysAllow || message.computerUseCloseRequestId) {
        if (pendingApproval?.serverId === COMPUTER_USE_SOURCE_ID) {
          rejectPendingApproval(pendingApproval.execution, 'Computer Use is unavailable for this run.');
        }
        const requestId = message.computerUseCloseRequestId;
        void closeComputerUseRuns().then(
          () => { if (requestId) writeJsonLine({ type: 'computer-use:closed', requestId, closed: true }); },
          () => { if (requestId) writeJsonLine({ type: 'computer-use:closed', requestId, closed: false }); },
        );
      }
      agentApiKey = message.agentApiKey;
      logSidecar('received config update');
      configUpdateQueue = configUpdateQueue.then(() => mcpRegistry.updateConfig(message.config));
      break;
    }
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
  const previousConversation =
    continueFrom && lastConversation?.agentRunId === continueFrom && lastConversation.provider === provider
      ? lastConversation : null;
  lastConversation = null;
  const previous = execution;
  if (previous?.phase === 'running') {
    previous.phase = 'cancelled';
    auditStore.record(previous.agentRunId, 'run_interrupted');
    previous.controller.abort();
    rejectPendingApproval(previous, 'Agent run was interrupted.');
    writeJsonLine({ type: 'agent:cancelled', agentRunId: previous.agentRunId });
  }

  const run: AgentExecution = {
    agentRunId, controller: new AbortController(), phase: 'running',
    audit: auditStore.forExecution(agentRunId, previousConversation?.usedComputerUse),
  };
  execution = run;
  const runController = run.controller;

  const currentConfig = config;
  const currentAgentApiKey = agentApiKey;
  const nativeExecutable = computerUseExecutable;
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
    // A replacement command must not open its native client while the
    // previous command's cancellation is still stopping a desktop action.
    const priorNativeClosed = !nativeExecutable || computerUseRuns.size === 0
      || await closeComputerUseRuns().then(() => true, () => false);
    if (!ownsExecution(run) || runController.signal.aborted) return;
    if (!priorNativeClosed) {
      const status = 'Computer Use is unavailable until Agent Mode restarts.';
      run.audit.record('status', { status });
      writeJsonLine({ type: 'agent:status', agentRunId, status });
    }

    const reportTool =(serverId: string, name: string) => {
      if (!ownsExecution(run)) return;
      const status = `Using tool: ${serverId}.${name}`;
      run.audit.record('status', { status });
      writeJsonLine({ type: 'agent:status', agentRunId, status });
    };
    const toolSnapshot = mcpRegistry.createRunSnapshot(
      run.audit.record, tool => reportTool(tool.serverId, tool.toolName)
    );
    const native = priorNativeClosed && nativeExecutable && nativeExecutable === computerUseExecutable ? createComputerUseRun({
      executable: nativeExecutable,
      signal: runController.signal,
      getConfig: () => computerUseExecutable === nativeExecutable ? config?.agent.computerUse : undefined,
      onToolStarted: name => {
        run.audit.markComputerUseExecuted();
        reportTool(COMPUTER_USE_SOURCE_ID, name);
      },
      onToolFinished: metadata => run.audit.record('computer_use_tool_execute', metadata),
    }) : null;
    if (native) computerUseRuns.add(native);

    try {
      let finalAnswer = '';
      const messages = await runAgent(agentRunId, transcript, currentConfig, {
        ...toolSnapshot.tools, ...native?.tools,
      }, runController.signal, {
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
          finalAnswer = response;
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
          if (ownsExecution(run)) run.audit.record(eventType, payload);
        },
        commitMemory: (revision, updates) => memoryCommitter.request(agentRunId, revision, updates, runController.signal),
        shouldLearnMemory: () => config?.agent.memoryEnabled === true && ownsExecution(run),
        onMemoryStatus: status => {
          if (ownsExecution(run)) writeJsonLine({ type: 'memory:status', agentRunId, status });
        },
      }, currentAgentApiKey, context, previousConversation?.messages);
      // A newer run may have started while this one finished; only the latest answer can be replied to.
      if (messages && execution === run && run.phase === 'completed' && config?.agent.enabled) {
        const usedComputerUse = run.audit.usedComputerUse || previousConversation?.usedComputerUse === true;
        lastConversation = {
          agentRunId, provider, usedComputerUse,
          messages: usedComputerUse ? [
            { role: 'user', content: transcript }, { role: 'assistant', content: finalAnswer },
          ] : messages,
        };
      }
    } finally {
      await Promise.all([
        toolSnapshot.close(),
        native?.close().then(() => computerUseRuns.delete(native)),
      ]);
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

  if (request.serverId === COMPUTER_USE_SOURCE_ID && !computerUseExecutable) {
    releaseQueue();
    return { approved: false, message: 'Computer Use is unavailable for this run.' };
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
      run.audit.record('approval_decision', {
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
      serverId: request.serverId,
      timeout,
      resolve: finish,
    };

    run.audit.record('approval_requested', {
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
  await Promise.all([mcpRegistry.close(), closeComputerUseRuns()]);
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
