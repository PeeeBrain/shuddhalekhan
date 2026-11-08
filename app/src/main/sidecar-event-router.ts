import type { BrowserWindow } from 'electron';
import type { SidecarEvent } from '../agent/protocol';
import type { McpServerRuntimeStatus, McpStatusSnapshot } from '../types/ipc';
import type { AgentPresenter } from './agent-presentation';

interface SidecarEventRouterDeps {
  getSettingsWindow: () => BrowserWindow | null;
  getActiveAgentRunId: () => string | null;
  presenter: AgentPresenter;
  openExternal: (url: string) => Promise<unknown>;
  mergeDiscoveredTools: (serverId: string, tools: Extract<SidecarEvent, { type: 'mcp:tools-discovered' }>['tools']) => void;
  getConfig: () => { agent: { mcpServers: Array<{ id: string; displayName: string }> } };
  recordMcpStatus: (status: McpServerRuntimeStatus) => McpStatusSnapshot;
  onAgentTerminal?: (agentRunId: string) => void;
  onMemoryEvent?: (event: Extract<SidecarEvent, { type: 'memory:propose' | 'memory:status' }>) => void;
}

type SidecarEventHandler<T extends SidecarEvent['type']> = (event: Extract<SidecarEvent, { type: T }>) => void;
type SidecarEventHandlers = {
  [T in SidecarEvent['type']]?: SidecarEventHandler<T>;
};

export interface SidecarEventRouter {
  handle: (event: SidecarEvent) => void;
}

export function createSidecarEventRouter(deps: SidecarEventRouterDeps): SidecarEventRouter {
  const whenActive = <T extends SidecarEvent & { agentRunId: string }>(handler: (event: T) => void) => (event: T) => {
    if (event.agentRunId !== deps.getActiveAgentRunId()) return;
    handler(event);
  };

  const handlers: SidecarEventHandlers = {
    'memory:propose': event => deps.onMemoryEvent?.(event),
    'memory:status': event => deps.onMemoryEvent?.(event),
    'sidecar:ready': () => {
      console.log('Agent sidecar ready');
    },
    'mcp:server-status': (event) => {
      console.log(`MCP server ${event.serverId}: ${event.status}`);
      const snapshot = deps.recordMcpStatus({
        serverId: event.serverId,
        status: event.status,
        ...(event.message !== undefined ? { message: event.message } : {}),
      });
      deps.getSettingsWindow()?.webContents.send('mcp:status-snapshot', snapshot);
    },
    'mcp:tools-discovered': (event) => {
      deps.mergeDiscoveredTools(event.serverId, event.tools);
    },
    'oauth:open-url': (event) => {
      deps.openExternal(event.url).catch((err) => {
        console.error(`Failed to open OAuth URL for ${event.serverId}:`, err);
      });
    },
    'agent:status': whenActive((event) => {
      console.log(`Agent run ${event.agentRunId}: ${event.status}`);
      deps.presenter.status(event.agentRunId, event.status);
      deps.getSettingsWindow()?.webContents.send('audit:run-updated', event.agentRunId);
    }),
    'agent:response-delta': whenActive((event) => {
      deps.presenter.streaming(event.agentRunId, event.response);
    }),
    'approval:requested': whenActive((event) => {
      console.log(`Agent run ${event.agentRunId} requested approval for ${event.serverId}:${event.toolName}`);
      // The waiting indicator belongs to the presentation layer; presenters
      // decide whether an explicit status precedes the approval card.
      const mcpServers = deps.getConfig().agent.mcpServers;
      const server = mcpServers.find((s) => s.id === event.serverId);
      deps.presenter.approval({
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
      console.log(`Agent run ${event.agentRunId} completed: ${event.response}`);
      deps.presenter.completed(event.agentRunId, event.response, event.toolSummary);
      deps.getSettingsWindow()?.webContents.send('audit:run-updated', event.agentRunId);
      deps.onAgentTerminal?.(event.agentRunId);
    }),
    'agent:failed': whenActive((event) => {
      console.error(`Agent run ${event.agentRunId} failed: ${event.error}`);
      deps.presenter.failed(event.agentRunId, event.error);
      deps.getSettingsWindow()?.webContents.send('audit:run-updated', event.agentRunId);
      deps.onAgentTerminal?.(event.agentRunId);
    }),
    'agent:cancelled': whenActive((event) => {
      console.log(`Agent run ${event.agentRunId} cancelled`);
      deps.presenter.cancelled(event.agentRunId);
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
