import { describe, expect, it, mock } from 'bun:test';

const createMCPClient = mock();
const writeJsonLine = mock();
const logSidecar = mock();

class FakeOAuthProvider {
  started = false;
  closed = false;

  async start(): Promise<void> {
    this.started = true;
  }
  close(): void {
    this.closed = true;
  }
  tokens() {
    return undefined;
  }
}

mock.module('../protocol', () => ({ writeJsonLine, logSidecar }));
import {
  AisdkMcpClientFactory,
  type McpOAuthProviderResolver,
  SidecarOAuthRedirectFactory,
  StdoutSidecarMessageTransporter,
} from '../mcp-registry-adapters';
import { ManagedStdioMcpTransport } from '../managed-stdio-transport';

const httpServer = {
  id: 'srv1',
  displayName: 'Test Server',
  enabled: true,
  transport: { type: 'http', url: 'http://localhost:3000/mcp', redirect: 'error' },
  discoveredTools: [],
  toolPolicies: {},
};

describe('MCP registry production adapters', () => {
  it('uses the managed transport with declared environment values for stdio servers', async () => {
    const previousToken = process.env.MCP_ADAPTER_TEST_TOKEN;
    const previousUndeclared = process.env.MCP_ADAPTER_TEST_UNDECLARED;
    process.env.MCP_ADAPTER_TEST_TOKEN = 'adapter-secret';
    process.env.MCP_ADAPTER_TEST_UNDECLARED = 'sidecar-secret';
    createMCPClient.mockResolvedValue({ tools: async () => ({}), close: async () => undefined });
    const oauthProviderResolver: McpOAuthProviderResolver = { resolve: () => undefined };

    try {
      await new AisdkMcpClientFactory(oauthProviderResolver, createMCPClient as never).connect({
        ...httpServer,
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: [],
          envVarNames: ['MCP_ADAPTER_TEST_TOKEN'],
        },
      } as never);

      const transport = createMCPClient.mock.calls.at(-1)?.[0].transport;
      expect(transport).toBeInstanceOf(ManagedStdioMcpTransport);

      // OS baseline for launching is inherited; declared values win over it;
      // redaction stays scoped to the declared secrets.
      const launch = transport.launch as { env: Record<string, string> };
      expect(launch.env.MCP_ADAPTER_TEST_TOKEN).toBe('adapter-secret');
      expect(launch.env.PATH ?? launch.env.Path).toBe(process.env.PATH ?? process.env.Path);
      expect(launch.env.MCP_ADAPTER_TEST_UNDECLARED).toBeUndefined();
      expect(transport.redactValues).toEqual(['adapter-secret']);
    } finally {
      if (previousToken === undefined) delete process.env.MCP_ADAPTER_TEST_TOKEN;
      else process.env.MCP_ADAPTER_TEST_TOKEN = previousToken;
      if (previousUndeclared === undefined) delete process.env.MCP_ADAPTER_TEST_UNDECLARED;
      else process.env.MCP_ADAPTER_TEST_UNDECLARED = previousUndeclared;
    }
  });

  it('denies redirects for a direct HTTP MCP connection without OAuth', async () => {
    const oauthProviderResolver: McpOAuthProviderResolver = {
      resolve: () => undefined,
    };
    createMCPClient.mockResolvedValue({ tools: async () => ({}), close: async () => undefined });

    await new AisdkMcpClientFactory(oauthProviderResolver, createMCPClient as never).connect(httpServer as never);

    expect(createMCPClient).toHaveBeenLastCalledWith({
      transport: {
        type: 'http',
        url: 'http://localhost:3000/mcp',
        authProvider: undefined,
        redirect: 'error',
        fetch: expect.any(Function),
      },
    });
  });

  it('connects HTTP MCP clients with the redirect provider created for that server', async () => {
    const oauthFactory = new SidecarOAuthRedirectFactory();
    const redirectServer = oauthFactory.create(httpServer as never);
    await redirectServer.start();
    createMCPClient.mockResolvedValue({ tools: async () => ({}), close: async () => undefined });

    const client = await new AisdkMcpClientFactory(oauthFactory, createMCPClient as never).connect(httpServer as never);

    expect(await client.tools()).toEqual({});
    expect(createMCPClient).toHaveBeenCalledWith({
      transport: {
        type: 'http',
        url: 'http://localhost:3000/mcp',
        authProvider: expect.anything(),
        redirect: 'error',
        fetch: expect.any(Function),
      },
    });
    await redirectServer.close();
  });

  it('obtains HTTP OAuth providers through an interface and forwards the registry token', async () => {
    let receivedTokens: { access_token: string } | undefined;
    const provider = new FakeOAuthProvider();
    const oauthProviderResolver: McpOAuthProviderResolver = {
      resolve: (_server: unknown, tokens?: { access_token: string }) => {
        receivedTokens = tokens;
        return provider as never;
      },
    };
    createMCPClient.mockResolvedValue({ tools: async () => ({}), close: async () => undefined });

    await new AisdkMcpClientFactory(oauthProviderResolver, createMCPClient as never).connect(
      httpServer as never,
      { access_token: 'token-1' },
    );

    expect(receivedTokens).toEqual({ access_token: 'token-1' });
    expect(createMCPClient).toHaveBeenLastCalledWith({
      transport: {
        type: 'http',
        url: 'http://localhost:3000/mcp',
        authProvider: provider,
        redirect: 'error',
        fetch: expect.any(Function),
      },
    });
  });

  it('follows HTTP redirects only for an opted-in server', async () => {
    const provider = new FakeOAuthProvider();
    const oauthProviderResolver: McpOAuthProviderResolver = {
      resolve: () => provider as never,
    };
    createMCPClient.mockResolvedValue({ tools: async () => ({}), close: async () => undefined });

    await new AisdkMcpClientFactory(oauthProviderResolver, createMCPClient as never).connect({
      ...httpServer,
      transport: { ...httpServer.transport, redirect: 'follow' },
    } as never);

    expect(createMCPClient).toHaveBeenLastCalledWith({
      transport: {
        type: 'http',
        url: 'http://localhost:3000/mcp',
        authProvider: provider,
        redirect: 'follow',
        fetch: expect.any(Function),
      },
    });
  });

  it('applies the server redirect policy to OAuth discovery and token fetches', async () => {
    const provider = new FakeOAuthProvider();
    const baseFetch = mock(async () => new Response(null, { status: 204 }));
    const oauthProviderResolver: McpOAuthProviderResolver = {
      resolve: () => provider as never,
    };
    createMCPClient.mockResolvedValue({ tools: async () => ({}), close: async () => undefined });

    await new AisdkMcpClientFactory(
      oauthProviderResolver,
      createMCPClient as never,
      baseFetch as never,
    ).connect({
      ...httpServer,
      transport: { ...httpServer.transport, redirect: 'follow' },
    } as never);

    const transport = createMCPClient.mock.calls.at(-1)?.[0].transport;
    await transport.fetch('https://auth.example.test/.well-known/oauth-authorization-server', {
      headers: { Accept: 'application/json' },
    });

    expect(baseFetch).toHaveBeenCalledWith(
      'https://auth.example.test/.well-known/oauth-authorization-server',
      { headers: { Accept: 'application/json' }, redirect: 'follow' },
    );
  });

  it('serializes registry status and discovery events through the sidecar protocol', () => {
    const transporter = new StdoutSidecarMessageTransporter();

    transporter.sendStatus('srv1', 'connecting');
    transporter.sendDiscoveredTools('srv1', [{ name: 'search', description: 'Search the web', inputSchema: {} }]);

    expect(writeJsonLine).toHaveBeenNthCalledWith(1, {
      type: 'mcp:server-status',
      serverId: 'srv1',
      status: 'connecting',
      message: undefined,
    });
    expect(writeJsonLine).toHaveBeenNthCalledWith(2, {
      type: 'mcp:tools-discovered',
      serverId: 'srv1',
      tools: [{ name: 'search', description: 'Search the web', inputSchema: {} }],
    });
  });
});
