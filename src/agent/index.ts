import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { logSidecar, parseElectronMessage, writeJsonLine } from './protocol';
import { runAgent } from './runtime';
import type { AppConfig } from '../types/ipc';
import type { ApprovalDecisionMessage } from './protocol';
import type { ToolApprovalDecision, ToolApprovalRequest } from './runtime';
import { AgentAuditStore } from './audit';
import { McpRegistry } from './mcp-registry';

let config: AppConfig | null = null;
let activeAgentRunId: string | null = null;
let activeAbortController: AbortController | null = null;
let pendingApproval: PendingApproval | null = null;
let approvalQueue: Promise<void> = Promise.resolve();
let configUpdateQueue: Promise<void> = Promise.resolve();
const auditStore = new AgentAuditStore();
const mcpRegistry = new McpRegistry();

const APPROVAL_TIMEOUT_MS = 30_000;
const APPROVAL_TIMEOUT_MESSAGE = 'Rejected: tool approval window expired.';

type PendingApproval = {
  agentRunId: string;
  approvalId: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (decision: ToolApprovalDecision) => void;
};

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

  switch (message.type) {
    case 'config:update':
      config = message.config;
      logSidecar('received config update');
      configUpdateQueue = configUpdateQueue.then(() => mcpRegistry.updateConfig(message.config));
      break;
    case 'agent:start':
      handleAgentStart(message.agentRunId, message.transcript);
      break;
    case 'agent:cancel':
      handleAgentCancel(message.agentRunId);
      break;
    case 'approval:decision':
      handleApprovalDecision(message);
      break;
  }
}

async function handleAgentStart(agentRunId: string, transcript: string): Promise<void> {
  const previousAgentRunId = activeAgentRunId;
  const previousAbortController = activeAbortController;

  if (previousAgentRunId && previousAbortController) {
    previousAbortController.abort();
    rejectPendingApproval(previousAgentRunId, 'Rejected: agent run was cancelled.');
    writeJsonLine({ type: 'agent:cancelled', agentRunId: previousAgentRunId });
  }

  activeAgentRunId = agentRunId;
  activeAbortController = new AbortController();

  const currentConfig = config;
  if (!currentConfig) {
    writeJsonLine({ type: 'agent:failed', agentRunId, error: 'No config available' });
    activeAgentRunId = null;
    activeAbortController = null;
    return;
  }

  try {
    await configUpdateQueue;
    const toolSnapshot = mcpRegistry.createRunSnapshot(
      (request) => requestToolApproval(agentRunId, request),
      (eventType, payload) => auditStore.record(agentRunId, eventType, payload)
    );

    try {
      await runAgent(agentRunId, transcript, currentConfig, toolSnapshot.tools, activeAbortController.signal, {
        onStatus: (status) => {
          if (activeAgentRunId !== agentRunId) return;
          auditStore.record(agentRunId, 'status', { status });
          writeJsonLine({ type: 'agent:status', agentRunId, status });
        },
        onResponseDelta: (delta, response) => {
          if (activeAgentRunId !== agentRunId) return;
          writeJsonLine({ type: 'agent:response-delta', agentRunId, delta, response });
        },
        onCompleted: (response, toolSummary) => {
          if (activeAgentRunId !== agentRunId) return;
          writeJsonLine({ type: 'agent:completed', agentRunId, response, toolSummary });
          activeAgentRunId = null;
          activeAbortController = null;
        },
        onFailed: (error) => {
          if (activeAgentRunId !== agentRunId) return;
          auditStore.record(agentRunId, 'failed', { error });
          writeJsonLine({ type: 'agent:failed', agentRunId, error });
          activeAgentRunId = null;
          activeAbortController = null;
        },
        onCancelled: () => {
          if (activeAgentRunId !== agentRunId) return;
          rejectPendingApproval(agentRunId, 'Rejected: agent run was cancelled.');
          auditStore.record(agentRunId, 'cancelled');
          writeJsonLine({ type: 'agent:cancelled', agentRunId });
          activeAgentRunId = null;
          activeAbortController = null;
        },
        requestToolApproval: (request) => requestToolApproval(agentRunId, request),
        onAudit: (eventType, payload) => auditStore.record(agentRunId, eventType, payload),
      });
    } finally {
      await toolSnapshot.close();
    }
  } catch (err) {
    if (activeAgentRunId !== agentRunId) return;
    logSidecar('unhandled agent start error', err);
    auditStore.record(agentRunId, 'failed', { error: err instanceof Error ? err.message : String(err) });
    writeJsonLine({
      type: 'agent:failed',
      agentRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    activeAgentRunId = null;
    activeAbortController = null;
  }
}

function handleAgentCancel(agentRunId: string): void {
  if (activeAgentRunId === agentRunId && activeAbortController) {
    activeAbortController.abort();
    rejectPendingApproval(agentRunId, 'Rejected: agent run was cancelled.');
    auditStore.record(agentRunId, 'cancelled', { reason: 'requested' });
    activeAgentRunId = null;
    activeAbortController = null;
  }
  writeJsonLine({
    type: 'agent:cancelled',
    agentRunId,
  });
}

async function requestToolApproval(agentRunId: string, request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
  const previousQueue = approvalQueue;
  let releaseQueue: () => void = () => undefined;
  approvalQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });

  await previousQueue;

  if (activeAgentRunId !== agentRunId) {
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
      agentRunId,
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
    pendingApproval.agentRunId !== message.agentRunId ||
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

function rejectPendingApproval(agentRunId: string, message: string): void {
  if (!pendingApproval || pendingApproval.agentRunId !== agentRunId) return;
  pendingApproval.resolve({ approved: false, message });
}

async function shutdown(): Promise<void> {
  activeAbortController?.abort();
  if (activeAgentRunId) {
    rejectPendingApproval(activeAgentRunId, 'Rejected: sidecar is shutting down.');
  }
  await mcpRegistry.close();
  auditStore.close();
}

process.once('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});
process.once('exit', () => {
  auditStore.close();
});

main();
