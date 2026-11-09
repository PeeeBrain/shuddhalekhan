import type { McpServerConfig } from '../../types/ipc';

export function createHttpMcpTransport(): Extract<McpServerConfig['transport'], { type: 'http' }> {
  return {
    type: 'http',
    url: '',
    redirect: 'error',
  };
}

export function createBlankMcpServer(): McpServerConfig {
  return {
    // Short on purpose: `${id}__${tool}` must fit providers' 64-character tool-name limit.
    id: `mcp-${Date.now().toString(36)}`,
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
    id: existingId ?? server.id,
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
