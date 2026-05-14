import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { McpRegistry } from '../mcp-registry';
import type { AgentRuntimeCallbacks } from '../runtime';

const createMCPClientMock = mock();
const authMock = mock();
const closeMock = mock(() => Promise.resolve());

type TestOAuthProvider = {
  saveTokens: (tokens: { access_token: string; token_type: string }) => void;
};

type TestMcpClientConfig = {
  transport: {
    authProvider: TestOAuthProvider;
  };
};

mock.module('@ai-sdk/mcp', () => ({
  createMCPClient: createMCPClientMock,
  auth: authMock,
}));

mock.module('@ai-sdk/mcp/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: mock(),
}));

mock.module('../protocol', () => ({
  writeJsonLine: mock(),
  logSidecar: mock(),
}));

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
        transport: { type: 'http', url: 'http://localhost:3000/mcp' },
        discoveredTools: [],
        toolPolicies: {},
      },
    ],
  },
};

describe('McpRegistry', () => {
  beforeEach(() => {
    process.env.APPDATA = mkdtempSync(join(tmpdir(), 'shudd-mcp-oauth-'));
    createMCPClientMock.mockClear();
    authMock.mockClear();
    authMock.mockImplementation(async (provider: TestOAuthProvider) => {
      provider.saveTokens({ access_token: 'token-1', token_type: 'Bearer' });
      return 'REDIRECT';
    });
    closeMock.mockClear();
  });

  it('connects enabled servers and creates namespaced tool snapshots', async () => {
    const search = { description: 'search', inputSchema: {}, execute: mock(async () => 'ok') };
    const deleteTool = { description: 'delete', inputSchema: {}, execute: mock(async () => 'deleted') };
    createMCPClientMock.mockImplementation(async () => ({
      tools: async () => ({ search, delete: deleteTool }),
      close: closeMock,
    }));

    const registry = new McpRegistry();
    await registry.updateConfig({
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        mcpServers: [
          {
            ...baseConfig.agent.mcpServers[0],
            toolPolicies: { 'srv1:delete': 'disabled' },
          },
        ],
      },
    } as never);

    expect(createMCPClientMock).toHaveBeenCalledWith({
      transport: {
        type: 'http',
        url: 'http://localhost:3000/mcp',
        authProvider: expect.any(Object),
      },
    });

    const snapshot = registry.createRunSnapshot(makeApproval());

    expect(snapshot.tools).toHaveProperty('srv1__search');
    expect(snapshot.tools).not.toHaveProperty('srv1__delete');
    expect(snapshot.tools).not.toHaveProperty('search');

    await registry.close();
  });

  it('attaches a generic OAuth provider to HTTP servers', async () => {
    createMCPClientMock.mockImplementation(async () => ({
      tools: async () => ({}),
      close: closeMock,
    }));

    const registry = new McpRegistry();
    await registry.updateConfig(baseConfig as never);

    const transport = createMCPClientMock.mock.calls[0]?.[0]?.transport;
    expect(transport.authProvider.clientMetadata).toEqual({
      redirect_uris: [expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/)],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Shuddhalekhan',
    });

    await registry.close();
  });

  it('retries a protected HTTP server after OAuth saves a token', async () => {
    const firstClose = mock(() => Promise.resolve());
    createMCPClientMock
      .mockImplementationOnce(async (config: TestMcpClientConfig) => ({
        tools: async () => {
          config.transport.authProvider.saveTokens({ access_token: 'token-1', token_type: 'Bearer' });
          throw new Error('Unauthorized');
        },
        close: firstClose,
      }))
      .mockImplementationOnce(async () => ({
        tools: async () => ({}),
        close: closeMock,
      }));

    const registry = new McpRegistry();
    await registry.updateConfig(baseConfig as never);

    expect(createMCPClientMock).toHaveBeenCalledTimes(2);
    expect(firstClose).toHaveBeenCalled();

    await registry.close();
  });

  it('applies policy changes without reconnecting existing servers', async () => {
    const execute = mock(async () => 'result');
    const send = { description: 'send', inputSchema: {}, execute };
    createMCPClientMock.mockImplementation(async () => ({
      tools: async () => ({ send }),
      close: closeMock,
    }));

    const registry = new McpRegistry();
    await registry.updateConfig(baseConfig as never);
    await registry.updateConfig({
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        mcpServers: [
          {
            ...baseConfig.agent.mcpServers[0],
            toolPolicies: { 'srv1:send': 'alwaysAllow' },
          },
        ],
      },
    } as never);

    const approval = makeApproval();
    const snapshot = registry.createRunSnapshot(approval);
    const result = await snapshot.tools.srv1__send.execute?.({ to: 'a@example.com' }, makeToolOptions());

    expect(createMCPClientMock).toHaveBeenCalledTimes(1);
    expect(approval).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith({ to: 'a@example.com' }, makeToolOptions());
    expect(result).toBe('result');

    await registry.close();
  });

  it('returns denial feedback instead of executing denied tools', async () => {
    const execute = mock(async () => 'result');
    const send = { description: 'send', inputSchema: {}, execute };
    createMCPClientMock.mockImplementation(async () => ({
      tools: async () => ({ send }),
      close: closeMock,
    }));

    const registry = new McpRegistry();
    await registry.updateConfig(baseConfig as never);

    const approval = makeApproval(async () => ({
      approved: false,
      message: 'Rejected: user said no.',
    }));
    const snapshot = registry.createRunSnapshot(approval);
    const result = await snapshot.tools.srv1__send.execute?.({ to: 'a@example.com' }, makeToolOptions());

    expect(approval).toHaveBeenCalledWith({
      serverId: 'srv1',
      toolName: 'send',
      modelToolName: 'srv1__send',
      arguments: { to: 'a@example.com' },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result).toBe('Rejected: user said no.');

    await registry.close();
  });

  it('returns approval timeout feedback without executing the tool', async () => {
    const execute = mock(async () => 'result');
    const send = { description: 'send', inputSchema: {}, execute };
    createMCPClientMock.mockImplementation(async () => ({
      tools: async () => ({ send }),
      close: closeMock,
    }));

    const registry = new McpRegistry();
    await registry.updateConfig(baseConfig as never);

    const approval = makeApproval(async () => ({
      approved: false,
      message: 'Rejected: tool approval window expired.',
    }));
    const snapshot = registry.createRunSnapshot(approval);
    const result = await snapshot.tools.srv1__send.execute?.({ to: 'a@example.com' }, makeToolOptions());

    expect(execute).not.toHaveBeenCalled();
    expect(result).toBe('Rejected: tool approval window expired.');

    await registry.close();
  });

  it('reports tool start before executing approved tools', async () => {
    const execute = mock(async () => 'result');
    const search = { description: 'search', inputSchema: {}, execute };
    createMCPClientMock.mockImplementation(async () => ({
      tools: async () => ({ search }),
      close: closeMock,
    }));

    const registry = new McpRegistry();
    await registry.updateConfig({
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        mcpServers: [
          {
            ...baseConfig.agent.mcpServers[0],
            toolPolicies: { 'srv1:search': 'alwaysAllow' },
          },
        ],
      },
    } as never);

    const onToolStarted = mock();
    const snapshot = registry.createRunSnapshot(makeApproval(), undefined, onToolStarted);
    await snapshot.tools.srv1__search.execute?.({ q: 'news' }, makeToolOptions());

    expect(onToolStarted).toHaveBeenCalledWith({
      serverId: 'srv1',
      toolName: 'search',
      modelToolName: 'srv1__search',
    });

    await registry.close();
  });
});

function makeApproval(
  implementation: AgentRuntimeCallbacks['requestToolApproval'] = async () => ({ approved: true })
): ReturnType<typeof mock> {
  return mock(implementation);
}

function makeToolOptions() {
  return {
    toolCallId: 'call-1',
    messages: [],
  };
}
