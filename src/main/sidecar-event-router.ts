import type { BrowserWindow } from 'electron';
import type { SidecarEvent } from '../agent/protocol';
import type { AppConfig, McpDiscoveredTool } from '../types/ipc';

interface SidecarEventRouterDeps {
  getSettingsWindow: () => BrowserWindow | null;
  getConfig: () => AppConfig;
  setConfig: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void;
  openExternal: (url: string) => Promise<unknown>;
  showAgentToast: (state: Parameters<typeof import('./agent-toast-window').showAgentToast>[0]) => void;
}

type SidecarEventHandler<T extends SidecarEvent['type']> = (event: Extract<SidecarEvent, { type: T }>) => void;
type SidecarEventHandlers = {
  [T in SidecarEvent['type']]?: SidecarEventHandler<T>;
};

export interface SidecarEventRouter {
  handle: (event: SidecarEvent) => void;
}

export function createSidecarEventRouter(deps: SidecarEventRouterDeps): SidecarEventRouter {
  const handlers: SidecarEventHandlers = {
    'sidecar:ready': () => {
      console.log('Agent sidecar ready');
    },
    'mcp:server-status': (event) => {
      console.log(`MCP server ${event.serverId}: ${event.status}`);
      deps.getSettingsWindow()?.webContents.send('mcp:server-status', {
        serverId: event.serverId,
        status: event.status,
        message: event.message,
      });
    },
    'mcp:tools-discovered': (event) => {
      persistDiscoveredTools(deps, event.serverId, event.tools);
    },
    'oauth:open-url': (event) => {
      deps.openExternal(event.url).catch((err) => {
        console.error(`Failed to open OAuth URL for ${event.serverId}:`, err);
      });
    },
    'agent:status': (event) => {
      console.log(`Agent run ${event.agentRunId}: ${event.status}`);
      deps.showAgentToast({ kind: 'status', agentRunId: event.agentRunId, message: event.status });
    },
    'agent:response-delta': (event) => {
      deps.showAgentToast({ kind: 'streaming', agentRunId: event.agentRunId, response: event.response });
    },
    'approval:requested': (event) => {
      console.log(`Agent run ${event.agentRunId} requested approval for ${event.serverId}:${event.toolName}`);
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
        toolName: event.toolName,
        modelToolName: event.modelToolName,
        arguments: event.arguments,
        expiresAt: event.expiresAt,
      });
    },
    'agent:completed': (event) => {
      console.log(`Agent run ${event.agentRunId} completed: ${event.response}`);
      deps.showAgentToast({
        kind: 'completed',
        agentRunId: event.agentRunId,
        response: event.response,
        toolSummary: event.toolSummary,
      });
    },
    'agent:failed': (event) => {
      console.error(`Agent run ${event.agentRunId} failed: ${event.error}`);
      deps.showAgentToast({ kind: 'failed', agentRunId: event.agentRunId, error: event.error });
    },
    'agent:cancelled': (event) => {
      console.log(`Agent run ${event.agentRunId} cancelled`);
      deps.showAgentToast({ kind: 'cancelled', agentRunId: event.agentRunId });
    },
  };

  return {
    handle(event) {
      const handler = handlers[event.type] as ((event: SidecarEvent) => void) | undefined;
      handler?.(event);
    },
  };
}

function persistDiscoveredTools(
  deps: Pick<SidecarEventRouterDeps, 'getConfig' | 'setConfig'>,
  serverId: string,
  tools: Array<{ name: string; description: string; inputSchema?: unknown }>
): void {
  const config = deps.getConfig();
  const discoveredAt = new Date().toISOString();
  const nextServers = config.agent.mcpServers.map((server) => {
    if (server.id !== serverId) return server;

    const discoveredTools: McpDiscoveredTool[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      discoveredAt,
    }));
    const toolPolicies = { ...server.toolPolicies };
    for (const tool of discoveredTools) {
      const key = `${server.id}:${tool.name}` as const;
      if (!toolPolicies[key]) toolPolicies[key] = 'alwaysAsk';
    }

    return {
      ...server,
      discoveredTools,
      toolPolicies,
    };
  });

  deps.setConfig('agent', {
    ...config.agent,
    mcpServers: nextServers,
  });
}
