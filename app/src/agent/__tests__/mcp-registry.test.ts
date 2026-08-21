import { describe, expect, it } from 'bun:test';
import type { Tool } from 'ai';
import { McpRegistry } from '../mcp-registry';
import type {
  McpClientConnection,
  McpClientFactory,
  McpRegistryPorts,
  OAuthRedirectServer,
  OAuthRedirectServerFactory,
  SidecarMessageTransporter,
} from '../mcp-registry';
import type { AgentRuntimeCallbacks } from '../runtime';

const baseConfig = {
  whisperUrl: 'http://localhost:8080/inference',
  selectedDeviceId: null,
  removeFillerWords: true,
  agent: {
    enabled: true,
    provider: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4.1-mini',
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      thinkingEnabled: true,
    },
    mcpServers: [
      {
        id: 'srv1',
        displayName: 'Test Server',
        enabled: true,
        transport: { type: 'http', url: 'http://localhost:3000/mcp', redirect: 'error' },
        discoveredTools: [],
        toolPolicies: {},
      },
    ],
  },
};

describe('McpRegistry', () => {
  it('waits for pending connections and reports how many enabled servers connected', async () => {
    let releaseConnection: ((connection: McpClientConnection) => void) | undefined;
    const pendingConnection = new Promise<McpClientConnection>((resolve) => {
      releaseConnection = resolve;
    });
    const ports = makePorts({});
    ports.mcpClientFactory.connect = async () => pendingConnection;
    const registry = new McpRegistry(ports);

    await registry.updateConfig(baseConfig as never);
    const settling = registry.settle(1000);
    releaseConnection?.(new FakeConnection({ search: makeTool('search') }));

    expect(await settling).toEqual({ connected: 1, enabled: 1 });
    await registry.close();
  });

  it('stops waiting at the deadline and keeps the connected subset', async () => {
    let releaseConnection: ((connection: McpClientConnection) => void) | undefined;
    const ports = makePorts({});
    ports.mcpClientFactory.connect = async () => new Promise<McpClientConnection>((resolve) => {
      releaseConnection = resolve;
    });
    const registry = new McpRegistry(ports);

    await registry.updateConfig(baseConfig as never);

    expect(await registry.settle(10)).toEqual({ connected: 0, enabled: 1 });
    releaseConnection?.(new FakeConnection({ search: makeTool('search') }));
    await registry.settle(1000);
    await registry.close();
  });

  it('waits for superseded connection attempts during registry shutdown', async () => {
    const staleConnection = new FakeConnection({ oldTool: makeTool('old') });
    const replacementConnection = new FakeConnection({ newTool: makeTool('new') });
    let releaseStale: ((connection: McpClientConnection) => void) | undefined;
    let connectionNumber = 0;
    const ports = makePorts({});
    ports.mcpClientFactory.connect = async () => {
      connectionNumber += 1;
      if (connectionNumber === 1) {
        return new Promise<McpClientConnection>((resolve) => {
          releaseStale = resolve;
        });
      }
      return replacementConnection;
    };
    const registry = new McpRegistry(ports);

    await registry.updateConfig(baseConfig as never);
    await registry.updateConfig(withServer({
      transport: { type: 'http', url: 'http://localhost:4000/mcp', redirect: 'error' },
    }) as never);
    await registry.settle(1000);

    let shutdownComplete = false;
    const closing = registry.close().then(() => {
      shutdownComplete = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shutdownComplete).toBe(false);

    releaseStale?.(staleConnection);
    await closing;
    expect(staleConnection.closed).toBe(true);
  });

  it('uses its injected client port to expose enabled server tools in a namespaced snapshot', async () => {
    const search = makeTool('search');
    const ports = makePorts({ srv1: [new FakeConnection({ search })] });
    const registry = new McpRegistry(ports);

    await registry.updateConfig(baseConfig as never);
    await registry.settle(1000);

    const snapshot = registry.createRunSnapshot(approve);
    expect(Object.keys(snapshot.tools)).toEqual(['srv1__search']);

    await snapshot.close();
    await registry.close();
  });

  it('reports connecting, discovered tools, and connected status through its message port', async () => {
    const ports = makePorts({ srv1: [new FakeConnection({ search: makeTool('Search the web') })] });
    const registry = new McpRegistry(ports);

    await registry.updateConfig(baseConfig as never);
    await registry.settle(1000);

    expect(ports.transporter.events).toEqual([
      ['status', 'srv1', 'connecting'],
      ['tools', 'srv1', [{ name: 'search', description: 'Search the web', inputSchema: {} }]],
      ['status', 'srv1', 'connected'],
    ]);

    await registry.close();
  });

  it('keeps an unchanged connection active while applying an updated tool policy', async () => {
    const connection = new FakeConnection({ send: makeTool('send') });
    const ports = makePorts({ srv1: [connection] });
    const registry = new McpRegistry(ports);

    await registry.updateConfig(baseConfig as never);
    await registry.settle(1000);
    await registry.updateConfig(withServer({ toolPolicies: { 'srv1:send': 'alwaysAllow' } }) as never);
    await registry.settle(1000);

    const snapshot = registry.createRunSnapshot(approve);
    expect(snapshot.tools.srv1__send.needsApproval).toBeUndefined();
    expect(connection.closed).toBe(false);

    await snapshot.close();
    await registry.close();
  });

  it('disconnects its client and OAuth redirect server when a connection configuration changes', async () => {
    const firstConnection = new FakeConnection({ search: makeTool('search') });
    const replacementConnection = new FakeConnection({ search: makeTool('search') });
    const ports = makePorts({ srv1: [firstConnection, replacementConnection] });
    const registry = new McpRegistry(ports);

    await registry.updateConfig(baseConfig as never);
    await registry.settle(1000);
    await registry.updateConfig(withServer({
      transport: { type: 'http', url: 'http://localhost:4000/mcp', redirect: 'error' },
    }) as never);
    await registry.settle(1000);

    expect(firstConnection.closed).toBe(true);
    expect(ports.oauthFactory.servers[0]?.closed).toBe(true);
    expect(ports.transporter.events).toContainEqual(['status', 'srv1', 'disconnected']);

    await registry.close();
  });

  it('recreates the affected connection when its redirect policy changes', async () => {
    const firstConnection = new FakeConnection({ search: makeTool('search') });
    const replacementConnection = new FakeConnection({ search: makeTool('search') });
    const ports = makePorts({ srv1: [firstConnection, replacementConnection] });
    const registry = new McpRegistry(ports);

    await registry.updateConfig(baseConfig as never);
    await registry.settle(1000);
    await registry.updateConfig(withServer({
      transport: { type: 'http', url: 'http://localhost:3000/mcp', redirect: 'follow' },
    }) as never);
    await registry.settle(1000);

    expect(firstConnection.closed).toBe(true);
    expect(ports.oauthFactory.servers[0]?.closed).toBe(true);
    expect(replacementConnection.closed).toBe(false);

    await registry.close();
  });

  it('keeps a replaced connection alive until the active run releases its snapshot', async () => {
    const firstConnection = new FakeConnection({ oldTool: makeTool('old') });
    const replacementConnection = new FakeConnection({ newTool: makeTool('new') });
    const ports = makePorts({ srv1: [firstConnection, replacementConnection] });
    const registry = new McpRegistry(ports);

    await registry.updateConfig(baseConfig as never);
    await registry.settle(1000);
    const activeRun = registry.createRunSnapshot(approve);

    await registry.updateConfig(withServer({
      transport: { type: 'http', url: 'http://localhost:4000/mcp', redirect: 'error' },
    }) as never);
    await registry.settle(1000);

    expect(firstConnection.closed).toBe(false);
    expect(Object.keys(activeRun.tools)).toEqual(['srv1__oldTool']);
    const nextRun = registry.createRunSnapshot(approve);
    expect(Object.keys(nextRun.tools)).toEqual(['srv1__newTool']);

    await activeRun.close();
    expect(firstConnection.closed).toBe(true);
    await nextRun.close();
    await registry.close();
  });

  it('cleans up failed connections and reports the failure without registering tools', async () => {
    const failingConnection = new FakeConnection({}, new Error('Server refused connection'));
    const ports = makePorts({ srv1: [failingConnection] });
    const registry = new McpRegistry(ports);

    await registry.updateConfig(baseConfig as never);
    await registry.settle(1000);

    expect(failingConnection.closed).toBe(true);
    expect(ports.oauthFactory.servers[0]?.closed).toBe(true);
    expect(ports.transporter.events).toContainEqual(['status', 'srv1', 'failed', 'Server refused connection']);
    expect(registry.createRunSnapshot(approve).tools).toEqual({});
  });

  it('attempts a failed connection key only once per generation', async () => {
    const ports = makePorts({
      srv1: [new FakeConnection({}, new Error('Server refused connection'))],
    });
    const registry = new McpRegistry(ports);

    await registry.updateConfig(baseConfig as never);
    await registry.settle(1000);
    await registry.updateConfig(withServer({ toolPolicies: { 'srv1:search': 'alwaysAllow' } }) as never);
    await registry.settle(1000);

    expect(ports.transporter.events.filter((event) => event[0] === 'status' && event[2] === 'connecting')).toHaveLength(1);
  });

  it('retries discovery with OAuth tokens that arrive during the initial connection', async () => {
    const initialConnection = new FakeConnection({}, new Error('Unauthorized'));
    const retriedConnection = new FakeConnection({ search: makeTool('search') });
    const ports = makePorts({ srv1: [initialConnection, retriedConnection] });
    initialConnection.onTools = () => {
      ports.oauthFactory.servers[0]?.setTokens({ access_token: 'token-1' });
      throw new Error('Unauthorized');
    };
    const registry = new McpRegistry(ports);

    await registry.updateConfig(baseConfig as never);
    await registry.settle(1000);
    await registry.close();

    expect(initialConnection.closed).toBe(true);
    expect(retriedConnection.closed).toBe(true);
  });

  it('cleans up the retry client when OAuth-assisted discovery fails again', async () => {
    const initialConnection = new FakeConnection({}, new Error('Unauthorized'));
    const retryConnection = new FakeConnection({}, new Error('Still unauthorized'));
    const ports = makePorts({ srv1: [initialConnection, retryConnection] });
    initialConnection.onTools = () => {
      ports.oauthFactory.servers[0]?.setTokens({ access_token: 'token-1' });
      throw new Error('Unauthorized');
    };
    const registry = new McpRegistry(ports);

    await registry.updateConfig(baseConfig as never);
    await registry.settle(1000);

    expect(initialConnection.closed).toBe(true);
    expect(retryConnection.closed).toBe(true);
    expect(ports.oauthFactory.servers[0]?.closed).toBe(true);
  });

  it('omits disabled tools and keeps always-ask tools under AI SDK approval', async () => {
    const ports = makePorts({ srv1: [new FakeConnection({ search: makeTool('search'), remove: makeTool('remove') })] });
    const registry = new McpRegistry(ports);

    await registry.updateConfig(
      withServer({ toolPolicies: { 'srv1:remove': 'disabled' } }) as never
    );
    await registry.settle(1000);

    const snapshot = registry.createRunSnapshot(approve);
    expect(snapshot.tools.srv1__search.needsApproval).toBe(true);
    expect(snapshot.tools).not.toHaveProperty('srv1__remove');

    await snapshot.close();
    await registry.close();
  });
});

class FakeConnection implements McpClientConnection {
  closed = false;
  onTools?: () => Record<string, Tool>;

  constructor(
    private readonly toolDefinitions: Record<string, Tool>,
    private readonly toolsError?: Error
  ) {}

  async tools(): Promise<Record<string, Tool>> {
    if (this.onTools) return this.onTools();
    if (this.toolsError) throw this.toolsError;
    return this.toolDefinitions;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeOAuthRedirectServer implements OAuthRedirectServer {
  closed = false;
  private accessToken: { access_token: string } | null = null;

  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
  tokens(): { access_token: string } | null {
    return this.accessToken;
  }
  setTokens(tokens: { access_token: string }): void {
    this.accessToken = tokens;
  }
}

class FakeOAuthRedirectServerFactory implements OAuthRedirectServerFactory {
  servers: FakeOAuthRedirectServer[] = [];

  create(): OAuthRedirectServer {
    const server = new FakeOAuthRedirectServer();
    this.servers.push(server);
    return server;
  }
}

class FakeMessageTransporter implements SidecarMessageTransporter {
  events: Array<
    | ['status', string, string, string?]
    | ['tools', string, Array<{ name: string; description: string; inputSchema?: unknown }>]
  > = [];

  sendStatus(serverId: string, status: 'connecting' | 'connected' | 'failed' | 'disconnected', message?: string): void {
    this.events.push(['status', serverId, status, message]);
  }
  sendDiscoveredTools(serverId: string, tools: Array<{ name: string; description: string; inputSchema?: unknown }>): void {
    this.events.push(['tools', serverId, tools]);
  }
  log(): void {}
}

function makePorts(connections: Record<string, FakeConnection[]>): McpRegistryPorts & {
  oauthFactory: FakeOAuthRedirectServerFactory;
  transporter: FakeMessageTransporter;
} {
  const oauthFactory = new FakeOAuthRedirectServerFactory();
  const transporter = new FakeMessageTransporter();
  const mcpClientFactory: McpClientFactory = {
    async connect(server) {
      const connection = connections[server.id]?.shift();
      if (!connection) throw new Error(`No fake connection available for ${server.id}.`);
      return connection;
    },
  };
  return { mcpClientFactory, oauthFactory, transporter };
}

function makeTool(description: string): Tool {
  return { description, inputSchema: {}, execute: async () => 'ok' } as unknown as Tool;
}

function withServer(serverOverrides: Record<string, unknown>) {
  return {
    ...baseConfig,
    agent: {
      ...baseConfig.agent,
      mcpServers: [{ ...baseConfig.agent.mcpServers[0], ...serverOverrides }],
    },
  };
}

const approve: AgentRuntimeCallbacks['requestToolApproval'] = async () => ({ approved: true });
