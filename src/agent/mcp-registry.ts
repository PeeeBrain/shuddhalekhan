import type { Tool } from 'ai';
import type { AgentToolApprovalPolicy, AppConfig, McpServerConfig } from '../types/ipc';
import type { AgentRuntimeCallbacks } from './runtime';
import { getMcpServerConnectionKey } from './mcp-server-config';

type RequestToolApproval = AgentRuntimeCallbacks['requestToolApproval'];
type AuditCallback = NonNullable<AgentRuntimeCallbacks['onAudit']>;
type ToolStartedCallback = NonNullable<AgentRuntimeCallbacks['onToolStarted']>;

export interface McpClientConnection {
  tools(): Promise<Record<string, Tool>>;
  close(): Promise<void>;
}

export interface McpClientFactory {
  connect(server: McpServerConfig, oauthTokens?: { access_token: string }): Promise<McpClientConnection>;
}

export interface OAuthRedirectServer {
  start(): Promise<void>;
  close(): Promise<void>;
  tokens(): { access_token: string } | null;
}

export interface OAuthRedirectServerFactory {
  create(server: McpServerConfig): OAuthRedirectServer;
}

export interface SidecarMessageTransporter {
  sendStatus(
    serverId: string,
    status: 'connecting' | 'connected' | 'failed' | 'disconnected',
    message?: string
  ): void;
  sendDiscoveredTools(
    serverId: string,
    tools: Array<{ name: string; description: string; inputSchema?: unknown }>
  ): void;
  log(message: string, error?: unknown): void;
}

export type McpRegistryPorts = {
  mcpClientFactory: McpClientFactory;
  oauthFactory: OAuthRedirectServerFactory;
  transporter: SidecarMessageTransporter;
};

type ManagedServer = {
  config: McpServerConfig;
  client: McpClientConnection;
  rawTools: Record<string, Tool>;
  oauthRedirectServer?: OAuthRedirectServer;
};

export class McpRegistry {
  private servers = new Map<string, ManagedServer>();
  private toolPolicies = new Map<string, AgentToolApprovalPolicy>();

  constructor(private readonly ports: McpRegistryPorts) {}

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

    return { tools, close: async () => undefined };
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.servers.keys()).map((serverId) => this.disconnect(serverId)));
  }

  private async connect(server: McpServerConfig): Promise<void> {
    this.ports.transporter.sendStatus(server.id, 'connecting');

    let oauthRedirectServer: OAuthRedirectServer | undefined;
    let client: McpClientConnection | undefined;
    try {
      if (server.transport.type === 'http') {
        oauthRedirectServer = this.ports.oauthFactory.create(server);
        await oauthRedirectServer.start();
      }

      client = await this.ports.mcpClientFactory.connect(server, oauthRedirectServer?.tokens() ?? undefined);
      const discovered = await this.discoverTools(server, client, oauthRedirectServer);
      client = discovered.client;
      const { rawTools } = discovered;
      this.servers.set(server.id, { config: server, client, rawTools, oauthRedirectServer });
      this.ports.transporter.sendDiscoveredTools(
        server.id,
        Object.entries(rawTools).map(([name, tool]) => ({
          name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: 'inputSchema' in tool ? tool.inputSchema : undefined,
        }))
      );
      this.ports.transporter.sendStatus(server.id, 'connected');
      this.ports.transporter.log(`MCP server connected: ${server.id} (${server.displayName})`);
    } catch (err) {
      await client?.close().catch(() => undefined);
      await oauthRedirectServer?.close().catch(() => undefined);
      this.ports.transporter.sendStatus(server.id, 'failed', formatErrorMessage(err));
      this.ports.transporter.log(`MCP server failed: ${server.id}`, err);
    }
  }

  private async discoverTools(
    server: McpServerConfig,
    client: McpClientConnection,
    oauthRedirectServer?: OAuthRedirectServer
  ): Promise<{ client: McpClientConnection; rawTools: Record<string, Tool> }> {
    try {
      return { client, rawTools: await client.tools() };
    } catch (err) {
      const oauthTokens = oauthRedirectServer?.tokens();
      if (!oauthTokens?.access_token) throw err;

      await client.close().catch(() => undefined);
      const retriedClient = await this.ports.mcpClientFactory.connect(server, oauthTokens);
      try {
        return { client: retriedClient, rawTools: await retriedClient.tools() };
      } catch (retryError) {
        await retriedClient.close().catch(() => undefined);
        throw retryError;
      }
    }
  }

  private async disconnect(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server) return;

    this.servers.delete(serverId);
    await server.client.close().catch(() => undefined);
    await server.oauthRedirectServer?.close().catch(() => undefined);
    this.ports.transporter.sendStatus(serverId, 'disconnected');
  }
}

function wrapToolWithPolicy(
  serverId: string,
  toolName: string,
  modelToolName: string,
  toolDef: Tool,
  policy: Exclude<AgentToolApprovalPolicy, 'disabled'>,
  _requestToolApproval: RequestToolApproval,
  onAudit?: AuditCallback,
  onToolStarted?: ToolStartedCallback
): Tool {
  return {
    ...toolDef,
    needsApproval: policy === 'alwaysAsk' ? true : undefined,
    execute: async (args, options) => {
      if (!toolDef.execute) throw new Error(`MCP tool ${serverId}:${toolName} is missing an execute handler.`);

      const startedAt = Date.now();
      onToolStarted?.({ serverId, toolName, modelToolName });
      onAudit?.('mcp_tool_execute_started', { serverId, toolName, modelToolName, arguments: args });

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

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatToolError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const record = err as Error & { cause?: unknown };
    return { name: err.name, message: err.message, stack: err.stack, cause: formatUnknownErrorValue(record.cause) };
  }

  return { message: String(err), value: formatUnknownErrorValue(err) };
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
    for (const [key, policy] of Object.entries(server.toolPolicies)) policies.set(key, policy);
  }
  return policies;
}
