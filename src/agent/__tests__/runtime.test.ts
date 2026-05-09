import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { runAgent } from '../runtime';
import type { AgentRuntimeCallbacks } from '../runtime';

const streamTextMock = mock();
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
  streamText: streamTextMock,
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
        thinkingEnabled: true,
      },
    mcpServers: [],
  },
};

describe('runAgent', () => {
  beforeEach(() => {
    streamTextMock.mockClear();
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
    streamTextMock.mockImplementation(() => makeStreamResult({
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

  it('uses a GPT-5-style structured system prompt with explicit agent controls', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock.mockImplementation(() => makeStreamResult({
      text: 'Done',
      steps: [{ toolCalls: [], toolResults: [] }],
      toolCalls: [],
      toolResults: [],
    }));

    const callbacks = makeCallbacks();

    await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    const systemPrompt = streamTextMock.mock.calls[0]?.[0].system;
    expect(systemPrompt).toContain('<identity>');
    expect(systemPrompt).toContain('<persistence>');
    expect(systemPrompt).toContain('<context_gathering>');
    expect(systemPrompt).toContain('<tool_preambles>');
    expect(systemPrompt).toContain('<approval_handling>');
    expect(systemPrompt).not.toContain('# Identity');
  });

  it('injects the current local datetime into each agent run prompt', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock.mockImplementation(() => makeStreamResult({
      text: 'Done',
      steps: [{ toolCalls: [], toolResults: [] }],
      toolCalls: [],
      toolResults: [],
    }));

    const callbacks = makeCallbacks();

    await runAgent('run-1', 'what happened today?', baseConfig as never, {}, new AbortController().signal, callbacks);

    const systemPrompt = streamTextMock.mock.calls[0]?.[0].system;
    expect(systemPrompt).toContain('<runtime_context>');
    expect(systemPrompt).toContain(`- Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    expect(systemPrompt).toMatch(/- Current local datetime: .+/);
    expect(systemPrompt).toMatch(/- Current UTC datetime: \d{4}-\d{2}-\d{2}T/);
  });

  it('does not require an API key for local providers', async () => {
    streamTextMock.mockImplementation(() => makeStreamResult({
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
          thinkingEnabled: true,
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
    streamTextMock.mockImplementation((options: { onStepFinish?: (args: unknown) => void }) => {
      options.onStepFinish?.({
        toolCalls: [{ toolName: 'weather' }],
        toolResults: [{ toolName: 'weather', result: 'sunny' }],
        text: 'Weather is sunny',
      });
      return makeStreamResult({
        text: 'Weather is sunny',
        steps: [
          {
            toolCalls: [{ toolName: 'weather' }],
            toolResults: [{ toolName: 'weather', result: 'sunny' }],
          },
        ],
        toolCalls: [{ toolName: 'weather' }],
        toolResults: [{ toolName: 'weather', result: 'sunny' }],
      });
    });

    const callbacks = makeCallbacks();

    await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onStatus).toHaveBeenCalledWith('Using tools: weather');
    expect(callbacks.onCompleted).toHaveBeenCalledWith('Weather is sunny', ['Used weather']);
  });

  it('performs fallback when max steps reached with pending tool calls', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    let callCount = 0;
    streamTextMock.mockImplementation((options: { onStepFinish?: (args: unknown) => void; onChunk?: (args: TextChunkEvent) => void }) => {
      callCount++;
      if (callCount === 1) {
        options.onStepFinish?.({
          toolCalls: [{ toolName: 'search' }],
          toolResults: [],
          text: '',
        });
        return makeStreamResult({
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
        });
      }
      options.onChunk?.({ chunk: { type: 'text-delta', text: 'Step ' } });
      options.onChunk?.({ chunk: { type: 'text-delta', text: 'limit fallback' } });
      return makeStreamResult({
        text: 'Step limit fallback',
        steps: [],
        toolCalls: [],
        toolResults: [],
      });
    });

    const callbacks = makeCallbacks();

    await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onStatus).toHaveBeenCalledWith('Step limit reached. Summarizing...');
    expect(callbacks.onResponseDelta).toHaveBeenCalledWith('Step ', 'Step ');
    expect(callbacks.onResponseDelta).toHaveBeenCalledWith('limit fallback', 'Step limit fallback');
    expect(callbacks.onCompleted).toHaveBeenCalledWith('Step limit fallback', expect.arrayContaining(['Max step guardrail reached']));
  });

  it('streams text deltas and completes with the accumulated response', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock.mockImplementation((options: { onChunk?: (args: TextChunkEvent) => void }) => {
      options.onChunk?.({ chunk: { type: 'text-delta', text: 'Hello' } });
      options.onChunk?.({ chunk: { type: 'text-delta', text: ' world' } });
      return makeStreamResult({
        text: 'Hello world',
        steps: [],
        toolCalls: [],
        toolResults: [],
      });
    });

    const callbacks = makeCallbacks();

    await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onResponseDelta).toHaveBeenNthCalledWith(1, 'Hello', 'Hello');
    expect(callbacks.onResponseDelta).toHaveBeenNthCalledWith(2, ' world', 'Hello world');
    expect(callbacks.onCompleted).toHaveBeenCalledWith('Hello world', []);
  });

  it('ignores blank streamed text deltas so the UI does not show an empty streaming toast', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock.mockImplementation((options: { onChunk?: (args: TextChunkEvent) => void }) => {
      options.onChunk?.({ chunk: { type: 'text-delta', text: '   ' } });
      options.onChunk?.({ chunk: { type: 'text-delta', text: '\n' } });
      options.onChunk?.({ chunk: { type: 'text-delta', text: 'Ready' } });
      return makeStreamResult({
        text: 'Ready',
        steps: [],
        toolCalls: [],
        toolResults: [],
      });
    });

    const callbacks = makeCallbacks();

    await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onResponseDelta).toHaveBeenCalledTimes(1);
    expect(callbacks.onResponseDelta).toHaveBeenCalledWith('Ready', 'Ready');
  });

  it('passes enabled thinking through request body reasoning without unsupported reasoningEffort values', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock.mockImplementation(() => makeStreamResult({
      text: 'Done',
      steps: [],
      toolCalls: [],
      toolResults: [],
    }));

    const callbacks = makeCallbacks();
    await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(streamTextMock.mock.calls[0]?.[0].providerOptions).toEqual({});

    const providerConfig = createOpenAICompatibleMock.mock.calls[0]?.[0];
    expect(providerConfig.transformRequestBody({ messages: [] })).toEqual({
      messages: [],
      reasoning: { effort: 'on' },
    });
  });

  it('omits request body reasoning when thinking is disabled', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock.mockImplementation(() => makeStreamResult({
      text: 'Done',
      steps: [],
      toolCalls: [],
      toolResults: [],
    }));

    const callbacks = makeCallbacks();
    await runAgent('run-1', 'hello', {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        provider: {
          ...baseConfig.agent.provider,
          thinkingEnabled: false,
        },
      },
    } as never, {}, new AbortController().signal, callbacks);

    expect(streamTextMock.mock.calls[0]?.[0].providerOptions).toEqual({});

    const providerConfig = createOpenAICompatibleMock.mock.calls[0]?.[0];
    expect(providerConfig.transformRequestBody({ messages: [] })).toEqual({ messages: [] });
  });

  it('passes thinking through request body reasoning for local providers', async () => {
    streamTextMock.mockImplementation(() => makeStreamResult({
      text: 'Done',
      steps: [],
      toolCalls: [],
      toolResults: [],
    }));

    const callbacks = makeCallbacks();
    await runAgent('run-1', 'hello', {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        provider: {
          baseUrl: 'http://localhost:1234/v1',
          model: 'nvidia/nemotron-3-nano-4b',
          apiKeyEnvVar: '',
          thinkingEnabled: true,
        },
      },
    } as never, {}, new AbortController().signal, callbacks);

    expect(streamTextMock.mock.calls[0]?.[0].providerOptions).toEqual({});

    const providerConfig = createOpenAICompatibleMock.mock.calls[0]?.[0];
    expect(providerConfig.transformRequestBody({ messages: [] })).toEqual({
      messages: [],
      reasoning: { effort: 'on' },
    });
  });

  it('calls onCancelled when aborted', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock.mockImplementation(() => {
      return {
        text: new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('aborted')), 10);
        }),
        steps: Promise.resolve([]),
        toolCalls: Promise.resolve([]),
        toolResults: Promise.resolve([]),
      };
    });

    const callbacks = makeCallbacks();
    const controller = new AbortController();
    controller.abort();

    await runAgent('run-1', 'hello', baseConfig as never, {}, controller.signal, callbacks);

    expect(callbacks.onCancelled).toHaveBeenCalled();
  });

  it('turns an empty no-tool model completion into a degraded visible response', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock.mockReturnValue({
      text: Promise.resolve(''),
      steps: Promise.resolve([{ toolCalls: [], toolResults: [] }]),
      toolCalls: Promise.resolve([]),
      toolResults: Promise.resolve([]),
    });

    const callbacks = makeCallbacks();
    await runAgent('run-1', 'say hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onAudit).toHaveBeenCalledWith('empty_response_degraded', {
      toolSummary: [],
      hadToolActivity: false,
    });
    expect(callbacks.onCompleted).toHaveBeenCalledWith(
      'The agent completed, but returned an empty response.',
      []
    );
  });

  it('summarizes observable tool activity when the final model response is empty', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock.mockReturnValue({
      text: Promise.resolve(''),
      steps: Promise.resolve([
        {
          toolCalls: [{ toolName: 'srv1__search' }],
          toolResults: [{ toolName: 'srv1__search', result: 'ok' }],
        },
      ]),
      toolCalls: Promise.resolve([{ toolName: 'srv1__search' }]),
      toolResults: Promise.resolve([{ toolName: 'srv1__search', result: 'ok' }]),
    });

    const callbacks = makeCallbacks();
    await runAgent('run-1', 'search web', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onAudit).toHaveBeenCalledWith('empty_response_degraded', {
      toolSummary: ['Used srv1__search'],
      hadToolActivity: true,
    });
    expect(callbacks.onCompleted).toHaveBeenCalledWith(
      'The agent completed tool work but returned no final text.',
      ['Used srv1__search']
    );
  });

});

function makeCallbacks(): AgentRuntimeCallbacks & { [K in keyof AgentRuntimeCallbacks]: ReturnType<typeof mock> } {
  return {
    onStatus: mock(() => undefined),
    onResponseDelta: mock(() => undefined),
    onCompleted: mock(() => undefined),
    onFailed: mock(() => undefined),
    onCancelled: mock(() => undefined),
    requestToolApproval: mock(async () => ({ approved: true })),
    onAudit: mock(() => undefined),
  };
}

type TextChunkEvent = {
  chunk: {
    type: 'text-delta';
    text: string;
  };
};

function makeStreamResult(result: {
  text: string;
  steps: Array<{ toolCalls: Array<{ toolName: string }>; toolResults: unknown[] }>;
  toolCalls: unknown[];
  toolResults: unknown[];
}) {
  return {
    text: Promise.resolve(result.text),
    steps: Promise.resolve(result.steps),
    toolCalls: Promise.resolve(result.toolCalls),
    toolResults: Promise.resolve(result.toolResults),
  };
}
