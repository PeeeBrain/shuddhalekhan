import type { AgentStep } from '../types/ipc';

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
 * run events here; the presenter projects them onto the shared runtime shell.
 */
export interface AgentPresenter {
  /** Invalidates any prior run presentation before a replacement run starts. */
  beginRun(): void;
  status(agentRunId: string | null, message: string): void;
  streaming(agentRunId: string, steps: AgentStep[]): void;
  approval(request: AgentApprovalPresentation): void;
  completed(agentRunId: string, response: string, toolSummary: string[], steps: AgentStep[]): void;
  failed(agentRunId: string | null, message: string): void;
  /** A cancelled run clears presentation silently; it never shows feedback. */
  cancelled(agentRunId: string): void;
}

interface RuntimeShellPresenterTarget {
  clearAgentRun(): void;
  showAgentStatus(agentRunId: string | null, message: string): void;
  showAgentStreaming(agentRunId: string, steps: AgentStep[]): void;
  showAgentApproval(approval: AgentApprovalPresentation): void;
  showAgentCompleted(agentRunId: string, response: string, toolSummary: string[], steps: AgentStep[]): void;
  showAgentFailed(agentRunId: string | null, message: string): void;
}

export function createRuntimeShellPresenter(shell: RuntimeShellPresenterTarget): AgentPresenter {
  return {
    beginRun: () => shell.clearAgentRun(),
    status: (agentRunId, message) => shell.showAgentStatus(agentRunId, message),
    streaming: (agentRunId, steps) => shell.showAgentStreaming(agentRunId, steps),
    approval: (request) => shell.showAgentApproval(request),
    completed: (agentRunId, response, toolSummary, steps) => shell.showAgentCompleted(agentRunId, response, toolSummary, steps),
    failed: (agentRunId, message) => shell.showAgentFailed(agentRunId, message),
    cancelled: () => shell.clearAgentRun(),
  };
}
