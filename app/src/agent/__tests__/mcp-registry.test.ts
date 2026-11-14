import { describe, expect, it } from 'bun:test';
import type { Tool } from 'ai';
import { McpRegistry } from '../mcp-registry';
import { SidecarOAuthProvider } from '../oauth-provider';
import type {
  McpClientConnection,
  McpClientFactory,
  McpRegistryPorts,
  OAuthRedirectServer,
  OAuthRedirectServerFactory,
  SidecarMessageTransporter,
} from '../mcp-registry';

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

  it('reconnects only the requested server when testing', async () => {
    const config = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        mcpServers: [
          { ...baseConfig.agent.mcpServers[0], id: 'a', displayName: 'A' },
          { ...baseConfig.agent.mcpServers[0], id: 'b', displayName: 'B' },
        ],
      },
    };
    const connectionA1 = new FakeConnection({ search: makeTool('search') });
    const connectionA2 = new FakeConnection({ search: makeTool('search-2') });
    const connectionB = new FakeConnection({ fetch: makeTool('fetch') });
    const ports = makePorts({ a: [connectionA1, connectionA2], b: [connectionB] });
    const registry = new McpRegistry(ports);

    await registry.updateConfig(config as never);
    await registry.settle(1000);

    await registry.testServer('a');
    await registry.settle(1000);

    expect(connectionA1.closed).toBe(true);
    expect(connectionB.closed).toBe(false);
    const statusEvents = ports.transporter.events.filter(([kind]) => kind === 'status');
    expect(statusEvents.filter(([, serverId]) => serverId === 'b').map(([, , state]) => state)).toEqual([
      'connecting', 'connected',
    ]);
    expect(statusEvents.filter(([, serverId]) => serverId === 'a').map(([, , state]) => state)).toEqual([
      'connecting', 'connected', 'disconnected', 'connecting', 'connected',
    ]);
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

  it.each(['disable', 'shutdown'] as const)('retires pending OAuth authorization on %s without publishing stale tools', async (action: 'disable' | 'shutdown') => {
    const ports = makePorts({});
    let provider: SidecarOAuthProvider | undefined;
    let settled = false;
    let entered: () => void = () => undefined;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const oauthFactory: OAuthRedirectServerFactory = { create(server) {
      const created = new SidecarOAuthProvider(server);
      provider = created;
      return { start: () => created.start(), close: async () => created.close(), tokens: () => null };
    } };
    ports.mcpClientFactory.connect = async () => {
      if (!provider) throw new Error('Missing OAuth provider');
      const pending = provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'));
      await Promise.resolve();
      entered();
      try { await pending; } finally { settled = true; }
      return new FakeConnection({ stale: makeTool('stale') });
    };
    const registry = new McpRegistry({ ...ports, oauthFactory });
    await registry.updateConfig(baseConfig as never);
    await waiting;
    if (action === 'disable') await registry.updateConfig(withServer({ enabled: false }) as never);
    await registry.close(100);
    expect(settled).toBe(true);
    expect(ports.transporter.events.filter(([kind]) => kind === 'tools')).toEqual([]);
    expect(ports.transporter.events.filter(([kind, , status]) => kind === 'status' && status !== 'connecting')).toEqual([]);
    expect(registry.createRunSnapshot().tools).toEqual({});
  });

  it('uses its injected client port to expose enabled server tools in a namespaced snapshot', async () => {
    const search = makeTool('search');
    const ports = makePorts({ srv1: [new FakeConnection({ search })] });
    const registry = new McpRegistry(ports);

    await registry.updateConfig(baseConfig as never);
    await registry.settle(1000);

    const snapshot = registry.createRunSnapshot();
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

    const snapshot = registry.createRunSnapshot();
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
    const activeRun = registry.createRunSnapshot();

    await registry.updateConfig(withServer({
      transport: { type: 'http', url: 'http://localhost:4000/mcp', redirect: 'error' },
    }) as never);
    await registry.settle(1000);

    expect(firstConnection.closed).toBe(false);
    expect(Object.keys(activeRun.tools)).toEqual(['srv1__oldTool']);
    const nextRun = registry.createRunSnapshot();
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
    expect(registry.createRunSnapshot().tools).toEqual({});
  });

  it('keeps only the newest attempt when the desired connection key cycles back', async () => {
    const registeredConnection = new FakeConnection({ search: makeTool('registered') });
    const k2Connection = new FakeConnection({ search: makeTool('k2') });
    const duplicateConnection = new FakeConnection({ search: makeTool('duplicate') });
    const releases: Array<((connection: McpClientConnection) => void) | undefined> = [];
    let attemptNumber = 0;
    const ports = makePorts({});
    ports.mcpClientFactory.connect = async () => {
      attemptNumber += 1;
      return new Promise<McpClientConnection>((resolve) => {
        releases[attemptNumber] = resolve;
      });
    };
    const registry = new McpRegistry(ports);

    // K1 -> K2 -> K1 while the first K1 attempt is pending leaves two live
    // attempts for the same connection key.
    await registry.updateConfig(baseConfig as never);
    await registry.updateConfig(withServer({
      transport: { type: 'http', url: 'http://localhost:4000/mcp', redirect: 'error' },
    }) as never);
    await registry.updateConfig(baseConfig as never);
    releases[1]?.(registeredConnection);
    releases[2]?.(k2Connection);
    releases[3]?.(duplicateConnection);
    await registry.settle(1000);

    // A retired attempt cannot revive even when its old key becomes desired again.
    expect(duplicateConnection.closed).toBe(false);
    expect(registeredConnection.closed).toBe(true);
    expect(ports.oauthFactory.servers.filter((server) => !server.closed)).toHaveLength(1);

    const snapshot = registry.createRunSnapshot();
    expect(Object.keys(snapshot.tools)).toEqual(['srv1__search']);
    expect(snapshot.tools.srv1__search.description).toBe('duplicate');

    await snapshot.close();
    await registry.close();
    expect(duplicateConnection.closed).toBe(true);
  });

  it('completes shutdown even when a leased server never releases its snapshot', async () => {
    const connection = new FakeConnection({ search: makeTool('search') });
    const ports = makePorts({ srv1: [connection] });
    const registry = new McpRegistry(ports);

    await registry.updateConfig(baseConfig as never);
    await registry.settle(1000);
    const activeRun = registry.createRunSnapshot();

    const closing = registry.close(20);
    await closing;
    // The lease was never released, so the deferred close must not have run.
    expect(connection.closed).toBe(false);

    await activeRun.close();
    expect(connection.closed).toBe(true);
    await registry.close();
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

    const snapshot = registry.createRunSnapshot();
    const needsApproval = snapshot.tools.srv1__search.needsApproval as () => boolean;
    expect(needsApproval()).toBe(true);
    expect(snapshot.tools).not.toHaveProperty('srv1__remove');

    // "Always allow" saved mid-run stops asking for the rest of that run.
    await registry.updateConfig(
      withServer({ toolPolicies: { 'srv1:remove': 'disabled', 'srv1:search': 'alwaysAllow' } }) as never
    );
    expect(needsApproval()).toBe(false);

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
