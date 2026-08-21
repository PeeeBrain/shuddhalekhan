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
  leaseCount: number;
  retired: boolean;
  closeStarted: boolean;
  closed: Promise<void>;
  resolveClosed: () => void;
};

export class McpRegistry {
  private servers = new Map<string, ManagedServer>();
  private pendingConnections = new Map<string, { connectionKey: string; promise: Promise<void> }>();
  private allPendingConnections = new Set<Promise<void>>();
  private attemptedConnectionKeys = new Map<string, string>();
  // Enabled-server ids are the keys of this map.
  private desiredConnectionKeys = new Map<string, string>();
  private toolPolicies = new Map<string, AgentToolApprovalPolicy>();

  constructor(private readonly ports: McpRegistryPorts) {}

  async updateConfig(config: AppConfig): Promise<void> {
    const enabledServers = new Map<string, McpServerConfig>();
    for (const server of config.agent.mcpServers) {
      if (server.enabled) enabledServers.set(server.id, server);
    }
    this.desiredConnectionKeys = new Map(
      [...enabledServers].map(([serverId, server]) => [serverId, getMcpServerConnectionKey(server)])
    );
    for (const serverId of this.attemptedConnectionKeys.keys()) {
      if (!enabledServers.has(serverId)) this.attemptedConnectionKeys.delete(serverId);
    }

    const disconnects: Promise<void>[] = [];
    for (const [serverId, server] of this.servers) {
      const nextConfig = enabledServers.get(serverId);
      if (!nextConfig || getMcpServerConnectionKey(server.config) !== getMcpServerConnectionKey(nextConfig)) {
        disconnects.push(this.disconnect(serverId));
      }
    }
    await Promise.all(disconnects);

    this.toolPolicies = collectToolPolicies(config);

    for (const server of enabledServers.values()) {
      const connectionKey = getMcpServerConnectionKey(server);
      if (this.servers.has(server.id)) {
        this.servers.get(server.id)!.config = server;
        continue;
      }
      if (this.pendingConnections.get(server.id)?.connectionKey === connectionKey) continue;
      if (this.attemptedConnectionKeys.get(server.id) === connectionKey) continue;

      this.attemptedConnectionKeys.set(server.id, connectionKey);
      const pending = {
        connectionKey,
        promise: Promise.resolve(),
      };
      pending.promise = this.connect(server, connectionKey).finally(() => {
        this.allPendingConnections.delete(pending.promise);
        if (this.pendingConnections.get(server.id) === pending) {
          this.pendingConnections.delete(server.id);
        }
      });
      this.allPendingConnections.add(pending.promise);
      this.pendingConnections.set(server.id, pending);
    }
  }

  async settle(timeoutMs: number): Promise<{ connected: number; enabled: number }> {
    const pending = [...this.pendingConnections.values()].map((attempt) => attempt.promise);
    if (pending.length > 0) {
      await waitForSettled(pending, timeoutMs);
    }

    let connected = 0;
    for (const serverId of this.desiredConnectionKeys.keys()) {
      if (this.servers.has(serverId)) connected += 1;
    }
    return { connected, enabled: this.desiredConnectionKeys.size };
  }

  createRunSnapshot(
    requestToolApproval: RequestToolApproval,
    onAudit?: AuditCallback,
    onToolStarted?: ToolStartedCallback
  ): { tools: Record<string, Tool>; close: () => Promise<void> } {
    const policies = new Map(this.toolPolicies);
    const tools: Record<string, Tool> = {};
    const leasedServers = [...this.servers.values()];
    for (const server of leasedServers) server.leaseCount += 1;

    for (const server of leasedServers) {
      const serverId = server.config.id;
      for (const [originalName, toolDef] of Object.entries(server.rawTools)) {
        const policyKey = `${serverId}:${originalName}` as const;
        const policy = policies.get(policyKey) ?? 'alwaysAsk';
        if (policy === 'disabled') continue;

        const modelName = `${serverId}__${originalName}`;
        tools[modelName] = wrapToolWithPolicy(
          serverId,
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

    let released = false;
    return {
      tools,
      close: async () => {
        if (released) return;
        released = true;
        await Promise.all(leasedServers.map(async (server) => {
          server.leaseCount -= 1;
          if (server.retired && server.leaseCount === 0) await this.closeManagedServer(server);
        }));
      },
    };
  }

  async close(): Promise<void> {
    this.desiredConnectionKeys.clear();
    const pending = [...this.allPendingConnections];
    await Promise.allSettled(pending);
    const servers = [...this.servers.values()];
    await Promise.all(Array.from(this.servers.keys()).map((serverId) => this.disconnect(serverId)));
    await Promise.all(servers.map((server) => server.closed));
  }

  private async connect(server: McpServerConfig, connectionKey: string): Promise<void> {
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
      if (this.desiredConnectionKeys.get(server.id) !== connectionKey) {
        await client.close().catch(() => undefined);
        await oauthRedirectServer?.close().catch(() => undefined);
        return;
      }
      let resolveClosed: () => void = () => undefined;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      this.servers.set(server.id, {
        config: server,
        client,
        rawTools,
        oauthRedirectServer,
        leaseCount: 0,
        retired: false,
        closeStarted: false,
        closed,
        resolveClosed,
      });
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
      if (this.desiredConnectionKeys.get(server.id) !== connectionKey) return;
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
    server.retired = true;
    this.ports.transporter.sendStatus(serverId, 'disconnected');
    if (server.leaseCount > 0) return;
    await this.closeManagedServer(server);
  }

  private async closeManagedServer(server: ManagedServer): Promise<void> {
    if (server.closeStarted) return server.closed;
    server.closeStarted = true;
    await server.client.close().catch(() => undefined);
    await server.oauthRedirectServer?.close().catch(() => undefined);
    server.resolveClosed();
  }
}

async function waitForSettled(promises: Promise<void>[], timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
