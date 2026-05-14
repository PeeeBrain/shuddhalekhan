import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { MCPClient } from '@ai-sdk/mcp';
import type { Tool } from 'ai';
import type { AgentToolApprovalPolicy, AppConfig, McpServerConfig } from '../types/ipc';
import { logSidecar, writeJsonLine } from './protocol';
import type { AgentRuntimeCallbacks, ToolApprovalRequest } from './runtime';

import { getMcpServerConnectionKey } from './mcp-server-config';
import { SidecarOAuthProvider } from './oauth-provider';

type RequestToolApproval = AgentRuntimeCallbacks['requestToolApproval'];
type AuditCallback = NonNullable<AgentRuntimeCallbacks['onAudit']>;
type ToolStartedCallback = NonNullable<AgentRuntimeCallbacks['onToolStarted']>;

type ManagedServer = {
  config: McpServerConfig;
  client: MCPClient;
  rawTools: Record<string, Tool>;
  oauthProvider?: SidecarOAuthProvider;
};

export class McpRegistry {
  private servers = new Map<string, ManagedServer>();
  private toolPolicies = new Map<string, AgentToolApprovalPolicy>();

  async updateConfig(config: AppConfig): Promise<void> {
    const enabledServers = new Map(config.agent.mcpServers.filter((server) => server.enabled).map((server) => [server.id, server]));

    for (const [serverId, server] of this.servers) {
      const nextConfig = enabledServers.get(serverId);
      if (!nextConfig || getMcpServerConnectionKey(server.config) !== getMcpServerConnectionKey(nextConfig)) {
        await this.disconnect(serverId);
      }
    }

    this.toolPolicies = collectToolPolicies(config);

    for (const server of enabledServers.values()) {
      if (this.servers.has(server.id)) {
        this.servers.get(server.id)!.config = server;
        continue;
      }

      await this.connect(server);
    }
  }

  createRunSnapshot(
    requestToolApproval: RequestToolApproval,
    onAudit?: AuditCallback,
    onToolStarted?: ToolStartedCallback
  ): { tools: Record<string, Tool>; close: () => Promise<void> } {
    const policies = new Map(this.toolPolicies);
    const tools: Record<string, Tool> = {};

    for (const server of this.servers.values()) {
      for (const [originalName, toolDef] of Object.entries(server.rawTools)) {
        const policyKey = `${server.config.id}:${originalName}` as const;
        const policy = policies.get(policyKey) ?? 'alwaysAsk';
        if (policy === 'disabled') continue;

        const modelName = `${server.config.id}__${originalName}`;
        tools[modelName] = wrapToolWithPolicy(
          server.config.id,
          originalName,
          modelName,
          toolDef,
          policy,
          requestToolApproval,
          onAudit,
          onToolStarted
        );
      }
    }

    return {
      tools,
      close: async () => undefined,
    };
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.servers.keys()).map((serverId) => this.disconnect(serverId)));
  }

  private async connect(server: McpServerConfig): Promise<void> {
    writeJsonLine({ type: 'mcp:server-status', serverId: server.id, status: 'connecting' });

    let oauthProvider: SidecarOAuthProvider | undefined;
    try {
      oauthProvider = await createOAuthProvider(server);
      const { client, rawTools } = await connectMcpClient(server, oauthProvider);
      this.servers.set(server.id, { config: server, client, rawTools, oauthProvider });
      writeJsonLine({
        type: 'mcp:tools-discovered',
        serverId: server.id,
        tools: Object.entries(rawTools).map(([name, tool]) => ({
          name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: 'inputSchema' in tool ? tool.inputSchema : undefined,
        })),
      });
      writeJsonLine({ type: 'mcp:server-status', serverId: server.id, status: 'connected' });
      logSidecar(`MCP server connected: ${server.id} (${server.displayName})`);
    } catch (err) {
      writeJsonLine({
        type: 'mcp:server-status',
        serverId: server.id,
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
      });
      logSidecar(`MCP server failed: ${server.id}`, err);
      oauthProvider?.close();
    }
  }

  private async disconnect(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server) return;

    this.servers.delete(serverId);
    await server.client.close().catch(() => undefined);
    server.oauthProvider?.close();
    writeJsonLine({ type: 'mcp:server-status', serverId, status: 'disconnected' });
  }
}

function createTransport(server: McpServerConfig, oauthProvider?: SidecarOAuthProvider) {
  if (server.transport.type === 'stdio') {
    const env: Record<string, string> = {};
    for (const name of server.transport.envVarNames) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return new Experimental_StdioMCPTransport({
      command: server.transport.command,
      args: server.transport.args,
      env,
    });
  }

  return {
    type: 'http' as const,
    url: server.transport.url,
    authProvider: oauthProvider,
  };
}

async function createOAuthProvider(server: McpServerConfig): Promise<SidecarOAuthProvider | undefined> {
  if (server.transport.type !== 'http') return undefined;
  const provider = new SidecarOAuthProvider(server);
  await provider.start();
  return provider;
}

async function connectMcpClient(
  server: McpServerConfig,
  oauthProvider?: SidecarOAuthProvider
): Promise<{ client: MCPClient; rawTools: Record<string, Tool> }> {
  try {
    return await createConnectedClient(server, oauthProvider);
  } catch (err) {
    if (!oauthProvider?.tokens()?.access_token) throw err;
    return await createConnectedClient(server, oauthProvider);
  }
}

async function createConnectedClient(
  server: McpServerConfig,
  oauthProvider?: SidecarOAuthProvider
): Promise<{ client: MCPClient; rawTools: Record<string, Tool> }> {
  const client = await createMCPClient({ transport: createTransport(server, oauthProvider) });
  try {
    const rawTools = (await client.tools()) as Record<string, Tool>;
    return { client, rawTools };
  } catch (err) {
    await client.close().catch(() => undefined);
    throw err;
  }
}

function wrapToolWithPolicy(
  serverId: string,
  toolName: string,
  modelToolName: string,
  toolDef: Tool,
  policy: Exclude<AgentToolApprovalPolicy, 'disabled'>,
  requestToolApproval: RequestToolApproval,
  onAudit?: AuditCallback,
  onToolStarted?: ToolStartedCallback
): Tool {
  return {
    ...toolDef,
    execute: async (args, options) => {
      if (policy === 'alwaysAsk') {
        const approval = await requestToolApproval({
          serverId,
          toolName,
          modelToolName,
          arguments: args,
        } satisfies ToolApprovalRequest);

        if (!approval.approved) return approval.message;
      }

      if (!toolDef.execute) {
        throw new Error(`MCP tool ${serverId}:${toolName} is missing an execute handler.`);
      }

      const startedAt = Date.now();
      onToolStarted?.({ serverId, toolName, modelToolName });
      onAudit?.('mcp_tool_execute_started', {
        serverId,
        toolName,
        modelToolName,
        arguments: args,
      });

      try {
        const result = await toolDef.execute(args, options);
        onAudit?.('mcp_tool_execute_result', {
          serverId,
          toolName,
          modelToolName,
          durationMs: Date.now() - startedAt,
          result,
        });
        return result;
      } catch (err) {
        onAudit?.('mcp_tool_execute_error', {
          serverId,
          toolName,
          modelToolName,
          durationMs: Date.now() - startedAt,
          error: formatToolError(err),
        });
        throw err;
      }
    },
  };
}

function formatToolError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const record = err as Error & { cause?: unknown };
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: formatUnknownErrorValue(record.cause),
    };
  }

  return {
    message: String(err),
    value: formatUnknownErrorValue(err),
  };
}

function formatUnknownErrorValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ['name', 'message', 'status', 'statusCode', 'responseBody', 'data', 'code']) {
    if (key in record) output[key] = record[key];
  }
  return Object.keys(output).length > 0 ? output : String(value);
}

function collectToolPolicies(config: AppConfig): Map<string, AgentToolApprovalPolicy> {
  const policies = new Map<string, AgentToolApprovalPolicy>();
  for (const server of config.agent.mcpServers) {
    for (const [key, policy] of Object.entries(server.toolPolicies)) {
      policies.set(key, policy);
    }
  }
  return policies;
}
