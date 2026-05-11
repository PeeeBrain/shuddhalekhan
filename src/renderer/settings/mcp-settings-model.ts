import type { McpServerConfig } from '../../types/ipc';

type IdFactory = () => string;

export function createBlankMcpServer(makeId: IdFactory = () => makeServerId('mcp')): McpServerConfig {
  return {
    id: makeId(),
    displayName: '',
    enabled: false,
    transport: {
      type: 'stdio',
      command: '',
      args: [],
      envVarNames: [],
    },
    discoveredTools: [],
    toolPolicies: {},
  };
}

export function normalizeDraftServer(
  server: McpServerConfig,
  existingId: string | null,
  makeId: IdFactory = () => makeServerId('mcp')
): McpServerConfig {
  return {
    ...server,
    id: existingId ?? makeId(),
    displayName: server.displayName.trim() || 'MCP Server',
  };
}

export function formatTransport(server: McpServerConfig): string {
  if (server.transport.type === 'http') return server.transport.url || 'HTTP endpoint not set';
  return [server.transport.command, ...server.transport.args].filter(Boolean).join(' ') || 'stdio command not set';
}

export function splitCommaList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function splitList(value: string): string[] {
  return value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function makeServerId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}
