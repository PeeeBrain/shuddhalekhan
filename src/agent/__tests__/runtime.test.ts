import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { runAgent } from '../runtime';
import type { AgentRuntimeCallbacks } from '../runtime';

const generateTextMock = mock();
const createOpenAICompatibleMock = mock(() => ({
  chatModel: mock(() => 'mock-model'),
}));
const stepCountIsMock = mock((n: number) => ({ stepCount: n }));
const createMCPClientMock = mock();
const closeMock = mock(() => Promise.resolve());
const Experimental_StdioMCPTransportMock = mock();

mock.module('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

mock.module('ai', () => ({
  generateText: generateTextMock,
  stepCountIs: stepCountIsMock,
}));

mock.module('@ai-sdk/mcp', () => ({
  createMCPClient: createMCPClientMock,
}));

mock.module('@ai-sdk/mcp/mcp-stdio', () => ({
  Experimental_StdioMCPTransport: Experimental_StdioMCPTransportMock,
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
    mcpServers: [],
  },
};

describe('runAgent', () => {
  beforeEach(() => {
    generateTextMock.mockClear();
    createOpenAICompatibleMock.mockClear();
    stepCountIsMock.mockClear();
    createMCPClientMock.mockClear();
    closeMock.mockClear();
    Experimental_StdioMCPTransportMock.mockClear();
    delete process.env.OPENROUTER_API_KEY;
  });

  it('fails when provider config is incomplete', async () => {
    const callbacks = makeCallbacks();
    const config = { ...baseConfig, agent: { ...baseConfig.agent, provider: { ...baseConfig.agent.provider, baseUrl: '' } } };

    await runAgent('run-1', 'hello', config as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onFailed).toHaveBeenCalledWith(
      'Agent provider configuration is incomplete. Check base URL and model in Settings.'
    );
  });

  it('fails when API key environment variable is missing', async () => {
    const callbacks = makeCallbacks();

    await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onFailed).toHaveBeenCalledWith(
      'API key environment variable "OPENROUTER_API_KEY" is not set.'
    );
  });

  it('fails clearly when a raw API key is entered instead of an environment variable name', async () => {
    const callbacks = makeCallbacks();
    const config = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        provider: {
          ...baseConfig.agent.provider,
          apiKeyEnvVar: 'sk-or-v1-test',
        },
      },
    };

    await runAgent('run-1', 'hello', config as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onFailed).toHaveBeenCalledWith(
      'Settings contains an API key value, but Shuddhalekhan expects an environment variable name. Set OPENROUTER_API_KEY in your shell, restart bun run dev, and put OPENROUTER_API_KEY in Settings.'
    );
  });

  it('completes successfully with no tools', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    generateTextMock.mockImplementation(async () => ({
      text: 'Done',
      steps: [{ toolCalls: [], toolResults: [] }],
      toolCalls: [],
      toolResults: [],
    }));

    const callbacks = makeCallbacks();

    await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onCompleted).toHaveBeenCalledWith('Done', []);
    expect(stepCountIsMock).toHaveBeenCalledWith(5);
  });

  it('does not require an API key for local providers', async () => {
    generateTextMock.mockImplementation(async () => ({
      text: 'Local done',
      steps: [],
      toolCalls: [],
      toolResults: [],
    }));

    const callbacks = makeCallbacks();
    const config = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        provider: {
          baseUrl: 'http://localhost:11434/v1',
          model: 'gemma3:270m',
          apiKeyEnvVar: '',
        },
      },
    };

    await runAgent('run-1', 'hello', config as never, {}, new AbortController().signal, callbacks);

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'shuddhalekhan-local-provider',
      baseURL: 'http://localhost:11434/v1',
    }));
    expect(callbacks.onCompleted).toHaveBeenCalledWith('Local done', []);
  });

  it('emits status during tool calls', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    generateTextMock.mockImplementation(async (options: { onStepFinish?: (args: unknown) => void }) => {
      options.onStepFinish?.({
        toolCalls: [{ toolName: 'weather' }],
        toolResults: [{ toolName: 'weather', result: 'sunny' }],
        text: 'Weather is sunny',
      });
      return {
        text: 'Weather is sunny',
        steps: [
          {
            toolCalls: [{ toolName: 'weather' }],
            toolResults: [{ toolName: 'weather', result: 'sunny' }],
          },
        ],
        toolCalls: [{ toolName: 'weather' }],
        toolResults: [{ toolName: 'weather', result: 'sunny' }],
      };
    });

    const callbacks = makeCallbacks();

    await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onStatus).toHaveBeenCalledWith('Using tools: weather');
    expect(callbacks.onCompleted).toHaveBeenCalledWith('Weather is sunny', ['Used weather']);
  });

  it('performs fallback when max steps reached with pending tool calls', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    let callCount = 0;
    generateTextMock.mockImplementation(async (options: { onStepFinish?: (args: unknown) => void }) => {
      callCount++;
      if (callCount === 1) {
        options.onStepFinish?.({
          toolCalls: [{ toolName: 'search' }],
          toolResults: [],
          text: '',
        });
        return {
          text: '',
          steps: [
            { toolCalls: [{ toolName: 'search' }], toolResults: [] },
            { toolCalls: [{ toolName: 'search' }], toolResults: [] },
            { toolCalls: [{ toolName: 'search' }], toolResults: [] },
            { toolCalls: [{ toolName: 'search' }], toolResults: [] },
            { toolCalls: [{ toolName: 'search' }], toolResults: [] },
          ],
          toolCalls: [{ toolName: 'search' }],
          toolResults: [],
        };
      }
      return {
        text: 'Step limit fallback',
        steps: [],
        toolCalls: [],
        toolResults: [],
      };
    });

    const callbacks = makeCallbacks();

    await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onStatus).toHaveBeenCalledWith('Step limit reached. Summarizing...');
    expect(callbacks.onCompleted).toHaveBeenCalledWith('Step limit fallback', expect.arrayContaining(['Max step guardrail reached']));
  });

  it('calls onCancelled when aborted', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    generateTextMock.mockImplementation(async () => {
      await new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('aborted')), 10);
      });
      return {} as never;
    });

    const callbacks = makeCallbacks();
    const controller = new AbortController();
    controller.abort();

    await runAgent('run-1', 'hello', baseConfig as never, {}, controller.signal, callbacks);

    expect(callbacks.onCancelled).toHaveBeenCalled();
  });

});

function makeCallbacks(): AgentRuntimeCallbacks & { [K in keyof AgentRuntimeCallbacks]: ReturnType<typeof mock> } {
  return {
    onStatus: mock(() => undefined),
    onCompleted: mock(() => undefined),
    onFailed: mock(() => undefined),
    onCancelled: mock(() => undefined),
    requestToolApproval: mock(async () => ({ approved: true })),
  };
}
