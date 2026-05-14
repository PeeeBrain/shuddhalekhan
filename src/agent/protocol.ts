import type { AppConfig } from '../types/ipc';

export type SidecarReadyEvent = {
  type: 'sidecar:ready';
  protocolVersion: 1;
};

export type McpServerStatusEvent = {
  type: 'mcp:server-status';
  serverId: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'failed';
  message?: string;
};

export type McpToolsDiscoveredEvent = {
  type: 'mcp:tools-discovered';
  serverId: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema?: unknown;
  }>;
};

export type AgentStatusEvent = {
  type: 'agent:status';
  agentRunId: string;
  status: string;
};

export type AgentResponseDeltaEvent = {
  type: 'agent:response-delta';
  agentRunId: string;
  delta: string;
  response: string;
};

export type ApprovalRequestedEvent = {
  type: 'approval:requested';
  agentRunId: string;
  approvalId: string;
  serverId: string;
  toolName: string;
  modelToolName: string;
  arguments: unknown;
  expiresAt: string;
};

export type AgentCompletedEvent = {
  type: 'agent:completed';
  agentRunId: string;
  response: string;
  toolSummary: string[];
};

export type AgentFailedEvent = {
  type: 'agent:failed';
  agentRunId: string;
  error: string;
};

export type AgentCancelledEvent = {
  type: 'agent:cancelled';
  agentRunId: string;
};

export type SidecarEvent =
  | SidecarReadyEvent
  | McpServerStatusEvent
  | McpToolsDiscoveredEvent
  | AgentStatusEvent
  | AgentResponseDeltaEvent
  | ApprovalRequestedEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentCancelledEvent;

export type ConfigUpdateMessage = {
  type: 'config:update';
  config: AppConfig;
};

export type AgentStartMessage = {
  type: 'agent:start';
  agentRunId: string;
  transcript: string;
};

export type AgentCancelMessage = {
  type: 'agent:cancel';
  agentRunId: string;
};

export type ApprovalDecisionMessage = {
  type: 'approval:decision';
  agentRunId: string;
  approvalId: string;
  decision: 'approved' | 'denied';
  message?: string;
};

export type ElectronToSidecarMessage =
  | ConfigUpdateMessage
  | AgentStartMessage
  | AgentCancelMessage
  | ApprovalDecisionMessage;

export function parseElectronMessage(line: string): ElectronToSidecarMessage | null {
  const parsed = JSON.parse(line) as Partial<ElectronToSidecarMessage>;

  switch (parsed.type) {
    case 'config:update':
    case 'agent:start':
    case 'agent:cancel':
    case 'approval:decision':
      return parsed as ElectronToSidecarMessage;
    default:
      return null;
  }
}

export function writeJsonLine(event: SidecarEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function logSidecar(message: string, error?: unknown): void {
  const suffix = error ? ` ${error instanceof Error ? error.message : String(error)}` : '';
  process.stderr.write(`[agent-sidecar] ${message}${suffix}\n`);
}
