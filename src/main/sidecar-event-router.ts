import type { BrowserWindow } from 'electron';
import type { SidecarEvent } from '../agent/protocol';
import { mergeDiscoveredTools } from './config';

interface SidecarEventRouterDeps {
  getSettingsWindow: () => BrowserWindow | null;
  getActiveAgentRunId: () => string | null;
  showAgentToast: (state: Parameters<typeof import('./agent-toast-window').showAgentToast>[0]) => void;
  openExternal: (url: string) => Promise<unknown>;
  mergeDiscoveredTools?: typeof mergeDiscoveredTools;
}

type SidecarEventHandler<T extends SidecarEvent['type']> = (event: Extract<SidecarEvent, { type: T }>) => void;
type SidecarEventHandlers = {
  [T in SidecarEvent['type']]?: SidecarEventHandler<T>;
};

export interface SidecarEventRouter {
  handle: (event: SidecarEvent) => void;
}

export function createSidecarEventRouter(deps: SidecarEventRouterDeps): SidecarEventRouter {
  const mergeTools = deps.mergeDiscoveredTools ?? mergeDiscoveredTools;
  const whenActive = <T extends SidecarEvent & { agentRunId: string }>(handler: (event: T) => void) => (event: T) => {
    if (event.agentRunId !== deps.getActiveAgentRunId()) return;
    handler(event);
  };

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
      mergeTools(event.serverId, event.tools);
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
    'agent:response-delta': whenActive((event) => {
      deps.showAgentToast({ kind: 'streaming', agentRunId: event.agentRunId, response: event.response });
    }),
    'approval:requested': whenActive((event) => {
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
    }),
    'agent:completed': whenActive((event) => {
      console.log(`Agent run ${event.agentRunId} completed: ${event.response}`);
      deps.showAgentToast({
        kind: 'completed',
        agentRunId: event.agentRunId,
        response: event.response,
        toolSummary: event.toolSummary,
      });
      deps.getSettingsWindow()?.webContents.send('audit:run-updated', event.agentRunId);
    }),
    'agent:failed': whenActive((event) => {
      console.error(`Agent run ${event.agentRunId} failed: ${event.error}`);
      deps.showAgentToast({ kind: 'failed', agentRunId: event.agentRunId, error: event.error });
      deps.getSettingsWindow()?.webContents.send('audit:run-updated', event.agentRunId);
    }),
    'agent:cancelled': whenActive((event) => {
      console.log(`Agent run ${event.agentRunId} cancelled`);
      deps.showAgentToast({ kind: 'cancelled', agentRunId: event.agentRunId });
      deps.getSettingsWindow()?.webContents.send('audit:run-updated', event.agentRunId);
    }),
  };

  return {
    handle(event) {
      const handler = handlers[event.type] as ((event: SidecarEvent) => void) | undefined;
      handler?.(event);
    },
  };
}
