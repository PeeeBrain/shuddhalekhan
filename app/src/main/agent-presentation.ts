import type { AgentToastState } from '../types/ipc';

export interface AgentApprovalPresentation {
  agentRunId: string;
  approvalId: string;
  serverId: string;
  serverDisplayName?: string;
  toolName: string;
  modelToolName: string;
  arguments: unknown;
  expiresAt: string;
}

/**
 * Semantic Agent Mode presentation boundary. The sidecar event router emits
 * run events here; the selected presenter projects them onto either the
 * shared runtime shell or the legacy toast window.
 */
export interface AgentPresenter {
  /** Invalidates any prior run presentation before a replacement run starts. */
  beginRun(): void;
  status(agentRunId: string | null, message: string): void;
  streaming(agentRunId: string, response: string): void;
  approval(request: AgentApprovalPresentation): void;
  completed(agentRunId: string, response: string, toolSummary: string[]): void;
  failed(agentRunId: string | null, message: string): void;
  /** A cancelled run clears presentation silently; it never shows feedback. */
  cancelled(agentRunId: string): void;
}

interface RuntimeShellPresenterTarget {
  beginAgentRun(): void;
  clearAgentRun(): void;
  showAgentStatus(agentRunId: string | null, message: string): void;
  showAgentStreaming(agentRunId: string, response: string): void;
  showAgentApproval(approval: AgentApprovalPresentation): void;
  showAgentCompleted(agentRunId: string, response: string, toolSummary: string[]): void;
  showAgentFailed(agentRunId: string | null, message: string): void;
}

export function createRuntimeShellPresenter(shell: RuntimeShellPresenterTarget): AgentPresenter {
  return {
    beginRun: () => shell.beginAgentRun(),
    status: (agentRunId, message) => shell.showAgentStatus(agentRunId, message),
    streaming: (agentRunId, response) => shell.showAgentStreaming(agentRunId, response),
    approval: (request) => shell.showAgentApproval(request),
    completed: (agentRunId, response, toolSummary) => shell.showAgentCompleted(agentRunId, response, toolSummary),
    failed: (agentRunId, message) => shell.showAgentFailed(agentRunId, message),
    cancelled: () => shell.clearAgentRun(),
  };
}

export function createLegacyToastPresenter(
  showToast: (state: AgentToastState) => void,
): AgentPresenter {
  return {
    // The legacy window has no run-invalidation concept; toasts replace each other.
    beginRun: () => undefined,
    status: (agentRunId, message) => {
      if (!agentRunId) return;
      showToast({ kind: 'status', agentRunId, message });
    },
    streaming: (agentRunId, response) => showToast({ kind: 'streaming', agentRunId, response }),
    approval: (request) => {
      // Legacy windows show one toast at a time; preserve the waiting status
      // that preceded the approval card before the shared shell existed.
      showToast({
        kind: 'status',
        agentRunId: request.agentRunId,
        message: `Waiting for approval: ${request.serverId}.${request.toolName}`,
      });
      showToast({
        kind: 'approval',
        agentRunId: request.agentRunId,
        approvalId: request.approvalId,
        serverId: request.serverId,
        ...(request.serverDisplayName ? { serverDisplayName: request.serverDisplayName } : {}),
        toolName: request.toolName,
        modelToolName: request.modelToolName,
        arguments: request.arguments,
        expiresAt: request.expiresAt,
      });
    },
    completed: (agentRunId, response, toolSummary) => {
      showToast({ kind: 'completed', agentRunId, response, toolSummary });
    },
    failed: (agentRunId, message) => {
      if (!agentRunId) return;
      showToast({ kind: 'failed', agentRunId, error: message });
    },
    cancelled: (agentRunId) => showToast({ kind: 'cancelled', agentRunId }),
  };
}
