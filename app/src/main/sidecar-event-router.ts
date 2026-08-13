import type { BrowserWindow } from 'electron';
import type { SidecarEvent } from '../agent/protocol';
import { emitPerformanceMarker } from './performance/marker-collector';

interface SidecarEventRouterDeps {
  getSettingsWindow: () => BrowserWindow | null;
  getActiveAgentRunId: () => string | null;
  showAgentToast: (state: Parameters<typeof import('./agent-toast-window').showAgentToast>[0]) => void;
  openExternal: (url: string) => Promise<unknown>;
  mergeDiscoveredTools: (serverId: string, tools: Extract<SidecarEvent, { type: 'mcp:tools-discovered' }>['tools']) => void;
  getConfig: () => { agent: { mcpServers: Array<{ id: string; displayName: string }> } };
  onAgentTerminal?: (agentRunId: string) => void;
}

type SidecarEventHandler<T extends SidecarEvent['type']> = (event: Extract<SidecarEvent, { type: T }>) => void;
type SidecarEventHandlers = {
  [T in SidecarEvent['type']]?: SidecarEventHandler<T>;
};

export interface SidecarEventRouter {
  handle: (event: SidecarEvent) => void;
}

export function createSidecarEventRouter(deps: SidecarEventRouterDeps): SidecarEventRouter {
  const firstDeltaRuns = new Set<string>();
  const whenActive = <T extends SidecarEvent & { agentRunId: string }>(handler: (event: T) => void) => (event: T) => {
    if (event.agentRunId !== deps.getActiveAgentRunId()) return;
    handler(event);
  };

  const handlers: SidecarEventHandlers = {
    'sidecar:ready': () => {
      console.log('Agent sidecar ready');
      emitPerformanceMarker('sidecar.ready');
    },
    'mcp:server-status': (event) => {
      console.log(`MCP server ${event.serverId}: ${event.status}`);
      if (event.status === 'connecting') {
        emitPerformanceMarker('mcp.connect.requested', { serverId: event.serverId });
      }
      deps.getSettingsWindow()?.webContents.send('mcp:server-status', {
        serverId: event.serverId,
        status: event.status,
        message: event.message,
      });
    },
    'mcp:tools-discovered': (event) => {
      emitPerformanceMarker('mcp.tools.discovered', { serverId: event.serverId });
      deps.mergeDiscoveredTools(event.serverId, event.tools);
    },
    'mcp:tool-execute-started': (event) => {
      emitPerformanceMarker('mcp.tool.execute.started', {
        agentRunId: event.agentRunId,
        serverId: event.serverId,
      });
    },
    'mcp:tool-execute-result': (event) => {
      emitPerformanceMarker('mcp.tool.execute.result', {
        agentRunId: event.agentRunId,
        serverId: event.serverId,
        outcome: event.outcome,
      });
    },
    'oauth:open-url': (event) => {
      deps.openExternal(event.url).catch((err) => {
        console.error(`Failed to open OAuth URL for ${event.serverId}:`, err);
      });
    },
    'agent:status': whenActive((event) => {
      console.log(`Agent run ${event.agentRunId}: ${event.status}`);
      deps.showAgentToast({ kind: 'status', agentRunId: event.agentRunId, message: event.status });
      deps.getSettingsWindow()?.webContents.send('audit:run-updated', event.agentRunId);
    }),
    'agent:provider-request-started': whenActive((event) => {
      emitPerformanceMarker('agent.provider.request.started', { agentRunId: event.agentRunId });
    }),
    'agent:response-delta': whenActive((event) => {
      if (!firstDeltaRuns.has(event.agentRunId)) {
        firstDeltaRuns.add(event.agentRunId);
        emitPerformanceMarker('agent.response.first-delta', { agentRunId: event.agentRunId });
      }
      deps.showAgentToast({ kind: 'streaming', agentRunId: event.agentRunId, response: event.response });
    }),
    'approval:requested': whenActive((event) => {
      emitPerformanceMarker('approval.requested', {
        agentRunId: event.agentRunId,
        serverId: event.serverId,
      });
      console.log(`Agent run ${event.agentRunId} requested approval for ${event.serverId}:${event.toolName}`);
      const mcpServers = deps.getConfig().agent.mcpServers;
      const server = mcpServers.find((s) => s.id === event.serverId);
      deps.showAgentToast({
        kind: 'status',
        agentRunId: event.agentRunId,
        message: `Waiting for approval: ${event.serverId}.${event.toolName}`,
      });
      deps.showAgentToast({
        kind: 'approval',
        agentRunId: event.agentRunId,
        approvalId: event.approvalId,
        serverId: event.serverId,
        ...(server?.displayName ? { serverDisplayName: server.displayName } : {}),
        toolName: event.toolName,
        modelToolName: event.modelToolName,
        arguments: event.arguments,
        expiresAt: event.expiresAt,
      });
    }),
    'agent:completed': whenActive((event) => {
      emitPerformanceMarker('agent.completed', { agentRunId: event.agentRunId });
      firstDeltaRuns.delete(event.agentRunId);
      console.log(`Agent run ${event.agentRunId} completed: ${event.response}`);
      deps.showAgentToast({
        kind: 'completed',
        agentRunId: event.agentRunId,
        response: event.response,
        toolSummary: event.toolSummary,
      });
      deps.getSettingsWindow()?.webContents.send('audit:run-updated', event.agentRunId);
      deps.onAgentTerminal?.(event.agentRunId);
    }),
    'agent:failed': whenActive((event) => {
      emitPerformanceMarker('agent.failed', { agentRunId: event.agentRunId });
      firstDeltaRuns.delete(event.agentRunId);
      console.error(`Agent run ${event.agentRunId} failed: ${event.error}`);
      deps.showAgentToast({ kind: 'failed', agentRunId: event.agentRunId, error: event.error });
      deps.getSettingsWindow()?.webContents.send('audit:run-updated', event.agentRunId);
      deps.onAgentTerminal?.(event.agentRunId);
    }),
    'agent:cancelled': whenActive((event) => {
      emitPerformanceMarker('agent.cancelled', { agentRunId: event.agentRunId });
      firstDeltaRuns.delete(event.agentRunId);
      console.log(`Agent run ${event.agentRunId} cancelled`);
      deps.showAgentToast({ kind: 'cancelled', agentRunId: event.agentRunId });
      deps.getSettingsWindow()?.webContents.send('audit:run-updated', event.agentRunId);
      deps.onAgentTerminal?.(event.agentRunId);
    }),
  };

  return {
    handle(event) {
      const handler = handlers[event.type] as ((event: SidecarEvent) => void) | undefined;
      handler?.(event);
    },
  };
}
