import type {
  AgentToolApprovalPolicy,
  McpServerConfig,
  McpToolPolicyKey,
} from '../types/ipc';

const DEFAULT_TOOL_POLICY: AgentToolApprovalPolicy = 'alwaysAsk';

export function makeMcpToolPolicyKey(serverId: string, toolName: string): McpToolPolicyKey {
  return `${serverId}:${toolName}`;
}

export function normalizeMcpServer(server: McpServerConfig): McpServerConfig {
  const discoveredTools = Array.isArray(server.discoveredTools) ? server.discoveredTools : [];
  const toolPolicies = { ...(server.toolPolicies ?? {}) };

  for (const tool of discoveredTools) {
    const key = makeMcpToolPolicyKey(server.id, tool.name);
    if (!toolPolicies[key]) {
      toolPolicies[key] = DEFAULT_TOOL_POLICY;
    }
  }

  return {
    ...server,
    enabled: server.enabled ?? false,
    discoveredTools,
    toolPolicies,
  };
}

export function normalizeMcpServers(servers: McpServerConfig[] | undefined): McpServerConfig[] {
  if (!Array.isArray(servers)) return [];

  const seenPresets = new Set<string>();
  return servers
    .filter((server) => {
      if (server.preset !== 'gmail') return true;
      if (seenPresets.has(server.preset)) return false;
      seenPresets.add(server.preset);
      return true;
    })
    .map(normalizeMcpServer);
}

export function getMcpServerConnectionKey(server: McpServerConfig): string {
  return JSON.stringify({
    enabled: server.enabled,
    transport: server.transport,
  });
}
