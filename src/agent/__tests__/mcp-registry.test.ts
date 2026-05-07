import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { McpRegistry } from '../mcp-registry';
import type { AgentRuntimeCallbacks } from '../runtime';

const createMCPClientMock = mock();
const closeMock = mock(() => Promise.resolve());

mock.module('@ai-sdk/mcp', () => ({
  createMCPClient: createMCPClientMock,
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
    createMCPClientMock.mockClear();
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

    const snapshot = registry.createRunSnapshot(makeApproval());

    expect(snapshot.tools).toHaveProperty('srv1__search');
    expect(snapshot.tools).not.toHaveProperty('srv1__delete');
    expect(snapshot.tools).not.toHaveProperty('search');

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
