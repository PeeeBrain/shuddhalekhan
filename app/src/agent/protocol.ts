import type { AgentProviderConfig, AgentProviderTestResult, AppConfig } from '../types/ipc';
import { z } from 'zod';
import { agentProviderSchema } from '../shared/agent-provider-validation';
import { memoryUpdatesSchema, type AgentMemoryCommitResult, type AgentMemoryUpdate, type AgentRunContext } from '../shared/agent-context';

export type SidecarReadyEvent = {
  type: 'sidecar:ready';
  protocolVersion: 1;
};

export type SidecarShutdownCompleteEvent = {
  type: 'sidecar:shutdown-complete';
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

export type McpToolExecuteStartedEvent = {
  type: 'mcp:tool-execute-started';
  agentRunId: string;
  serverId: string;
  toolName: string;
};

export type McpToolExecuteResultEvent = {
  type: 'mcp:tool-execute-result';
  agentRunId: string;
  serverId: string;
  toolName: string;
  outcome: 'success' | 'error';
};

export type OAuthOpenUrlEvent = {
  type: 'oauth:open-url';
  serverId: string;
  url: string;
};

export type AgentStatusEvent = {
  type: 'agent:status';
  agentRunId: string;
  status: string;
};

export type AgentProviderRequestStartedEvent = {
  type: 'agent:provider-request-started';
  agentRunId: string;
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
  | { type: 'memory:propose'; agentRunId: string; requestId: string; revision: string; updates: AgentMemoryUpdate[] }
  | { type: 'memory:status'; agentRunId: string; status: string }
  | { type: 'provider:test-result'; requestId: string; result: AgentProviderTestResult }
  | SidecarReadyEvent
  | SidecarShutdownCompleteEvent
  | McpServerStatusEvent
  | McpToolsDiscoveredEvent
  | McpToolExecuteStartedEvent
  | McpToolExecuteResultEvent
  | OAuthOpenUrlEvent
  | AgentStatusEvent
  | AgentProviderRequestStartedEvent
  | AgentResponseDeltaEvent
  | ApprovalRequestedEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentCancelledEvent;

export type ConfigUpdateMessage = {
  type: 'config:update';
  config: AppConfig;
  agentApiKey?: string;
};

export type AgentStartMessage = {
  type: 'agent:start';
  agentRunId: string;
  transcript: string;
  context?: AgentRunContext;
};

export type AgentCancelMessage = {
  type: 'agent:cancel';
  agentRunId: string;
};

export type McpTestServerMessage = {
  type: 'mcp:test-server';
  serverId: string;
};

export type SidecarShutdownRequestMessage = {
  type: 'sidecar:shutdown';
};

export type ApprovalDecisionMessage = {
  type: 'approval:decision';
  agentRunId: string;
  approvalId: string;
  decision: 'approved' | 'denied';
  message?: string;
};

export type ElectronToSidecarMessage =
  | { type: 'memory:commit-result'; agentRunId: string; requestId: string; result: AgentMemoryCommitResult }
  | { type: 'provider:test'; requestId: string; provider: AgentProviderConfig; apiKey?: string }
  | { type: 'provider:cancel-test'; requestId: string }
  | ConfigUpdateMessage
  | AgentStartMessage
  | AgentCancelMessage
  | ApprovalDecisionMessage
  | McpTestServerMessage
  | SidecarShutdownRequestMessage;

export function parseElectronMessage(line: string): ElectronToSidecarMessage | null {
  let parsed: Partial<ElectronToSidecarMessage>;
  try {
    parsed = JSON.parse(line) as Partial<ElectronToSidecarMessage>;
  } catch {
    return null;
  }

  switch (parsed.type) {
    case 'provider:test': {
      const result = z.object({
        type: z.literal('provider:test'), requestId: z.string().min(1),
        provider: agentProviderSchema, apiKey: z.string().optional(),
      }).safeParse(parsed);
      return result.success ? result.data : null;
    }
    case 'provider:cancel-test': {
      const result = z.object({ type: z.literal('provider:cancel-test'), requestId: z.string().min(1) }).safeParse(parsed);
      return result.success ? result.data : null;
    }
    case 'memory:commit-result': {
      const result = z.object({ type: z.literal('memory:commit-result'), agentRunId: z.string().min(1), requestId: z.string().min(1),
        result: z.discriminatedUnion('saved', [z.object({ saved: z.literal(true), message: z.string().optional() }), z.object({ saved: z.literal(false), message: z.string() })]),
      }).safeParse(parsed);
      return result.success ? result.data : null;
    }
    case 'agent:start': {
      const result = z.object({ type: z.literal('agent:start'), agentRunId: z.string().min(1), transcript: z.string(), context: z.object({
        skillsDirectory: z.string().min(1), memory: z.object({ revision: z.string(), markdown: z.string().max(8192) }).nullable(),
      }).optional() }).safeParse(parsed);
      return result.success ? result.data : null;
    }
    case 'config:update':
    case 'agent:cancel':
    case 'approval:decision':
    case 'mcp:test-server':
    case 'sidecar:shutdown':
      return parsed as ElectronToSidecarMessage;
    default:
      return null;
  }
}

export function parseMemoryProposal(event: unknown) {
  return z.object({ type: z.literal('memory:propose'), agentRunId: z.string().min(1), requestId: z.string().min(1), revision: z.string(), updates: memoryUpdatesSchema }).safeParse(event);
}

export function writeJsonLine(event: SidecarEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function logSidecar(message: string, error?: unknown): void {
  const suffix = error ? ` ${error instanceof Error ? error.message : String(error)}` : '';
  process.stderr.write(`[agent-sidecar] ${message}${suffix}\n`);
}
