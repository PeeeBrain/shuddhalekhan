import type { McpServerConfig } from '../../types/ipc';

type IdFactory = () => string;

export function createHttpMcpTransport(): Extract<McpServerConfig['transport'], { type: 'http' }> {
  return {
    type: 'http',
    url: '',
    redirect: 'error',
  };
}

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
  let transport = server.transport;
  if (transport.type === 'http' && transport.oauth) {
    const { oauth, ...http } = transport;
    transport = oauth.clientId.trim()
      ? { ...http, oauth: { ...oauth, scopes: splitCommaList(oauth.scopes.join(',')) } }
      : http;
  }
  return {
    ...server,
    id: existingId ?? makeId(),
    displayName: server.displayName.trim() || 'MCP Server',
    transport,
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
