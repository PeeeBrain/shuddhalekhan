import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { runAgent } from '../runtime';
import type { AgentRuntimeCallbacks } from '../runtime';

const streamTextMock = mock();
const isStepCountMock = mock((n: number) => ({ stepCount: n }));
const createMCPClientMock = mock();
const closeMock = mock(() => Promise.resolve());
const actualAi = { ...await import('ai') };
const actualMcp = { ...await import('@ai-sdk/mcp') };

mock.module('ai', () => ({
  streamText: streamTextMock,
  isStepCount: isStepCountMock,
}));

mock.module('@ai-sdk/mcp', () => ({
  createMCPClient: createMCPClientMock,
}));

afterAll(() => {
  mock.module('ai', () => actualAi);
  mock.module('@ai-sdk/mcp', () => actualMcp);
});

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
        reasoningEffort: 'high' as const,
      },
    mcpServers: [],
  },
};

describe('runAgent', () => {
  beforeEach(() => {
    streamTextMock.mockClear();
    isStepCountMock.mockClear();
    createMCPClientMock.mockClear();
    closeMock.mockClear();
    delete process.env.OPENROUTER_API_KEY;
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

    expect(callbacks.onCompleted).toHaveBeenCalledWith('Done', [], []);
    expect(isStepCountMock).toHaveBeenCalledWith(30);
  });

  it('reports the provider error carried by an AI SDK error stream part', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock.mockImplementation(() => makeStreamResult({
      text: '',
      steps: [],
      toolCalls: [],
      toolResults: [],
      streamParts: [{
        type: 'error',
        error: {
          message: 'Provider rejected the request',
          statusCode: 400,
          responseBody: { error: 'Unsupported reasoning option' },
        },
      }],
    }));
    const callbacks = makeCallbacks();

    await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onFailed).toHaveBeenCalledWith(
      expect.stringContaining('The provider rejected the request settings.')
    );
    expect(callbacks.onAudit).toHaveBeenCalledWith('run_failed', expect.objectContaining({
      diagnostic: expect.objectContaining({ kind: 'unsupported', statusCode: 400 }),
    }));
  });

  it('puts custom instructions in a system prompt that stays byte-identical across runs', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock.mockImplementation(() => makeStreamResult({
      text: 'Done',
      steps: [{ toolCalls: [], toolResults: [] }],
      toolCalls: [],
      toolResults: [],
    }));
    const config = { ...baseConfig, agent: { ...baseConfig.agent, customInstructions: '  Reply in French.\n' } };

    await runAgent('run-1', 'hello', config as never, {}, new AbortController().signal, makeCallbacks());
    await runAgent('run-2', 'what time is it?', config as never, {}, new AbortController().signal, makeCallbacks());

    const first = streamTextMock.mock.calls[0]?.[0].instructions.content;
    const second = streamTextMock.mock.calls[1]?.[0].instructions.content;
    expect(first).toEndWith('Reply in French.\n</user_instructions>');
    expect(second).toBe(first);
    expect(streamTextMock.mock.calls[0]?.[0].messages[0].content).not.toContain('Reply in French.');
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

    const request = streamTextMock.mock.calls[0]?.[0];
    expect(request.instructions.content).not.toContain('<runtime_context>');
    const context = request.messages[0].content;
    expect(context).toContain('<runtime_context>');
    expect(context).toContain(`- Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    expect(context).toMatch(/- Current local datetime: .+/);
    expect(context).toMatch(/- Current UTC datetime: \d{4}-\d{2}-\d{2}T/);
    expect(context).toEndWith('what happened today?');
  });

  it('emits status during tool calls', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock.mockImplementation((options: { onStepEnd?: (args: unknown) => void }) => {
      options.onStepEnd?.({
        usage: { inputTokens: 1, outputTokens: 1, inputTokenDetails: {} },
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
    expect(callbacks.onCompleted).toHaveBeenCalledWith('Weather is sunny', [], []);
  });

  it('spends one step budget across approval pauses and forces a tool-free answer on the last step', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    const step = { toolCalls: [{ toolName: 'srv1__search' }], toolResults: [] };
    type Prepared = { messages: Array<{ role: string }>; toolChoice?: string };
    const prepared: Prepared[] = [];
    streamTextMock
      .mockImplementationOnce(() => makeStreamResult({
        text: '', steps: Array.from({ length: 29 }, () => step), toolCalls: [], toolResults: [],
        streamParts: [makeApprovalRequest('approval-1', 'call-1', 'srv1__search', {})],
      }))
      .mockImplementationOnce((options: { prepareStep(input: { messages: unknown[]; stepNumber: number }): Prepared }) => {
        prepared.push(options.prepareStep({ messages: [{ role: 'user', content: 'hello' }], stepNumber: 0 }));
        return makeStreamResult({ text: 'Searched twice; one search remains.', steps: [{ toolCalls: [], toolResults: [] }], toolCalls: [], toolResults: [] });
      });

    const callbacks = makeCallbacks();
    await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(isStepCountMock.mock.calls).toEqual([[30], [1]]);
    expect(prepared[0]?.toolChoice).toBe('none');
    expect(prepared[0]?.messages.at(-1)).toMatchObject({ role: 'user', content: [{ text: expect.stringContaining('maximum number of steps') }] });
    expect(callbacks.onCompleted).toHaveBeenCalledWith('Searched twice; one search remains.', expect.arrayContaining(['Max step guardrail reached']), expect.anything());
  });

  it('marks an answer cut off at the output limit even when the tool list is too long to show', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    const tool = (toolName: string) => ({ toolCalls: [{ toolName }], toolResults: [] });
    streamTextMock.mockImplementation(() => makeStreamResult({
      text: 'Half an ans',
      steps: [tool('a'), tool('b'), tool('c'), { toolCalls: [], toolResults: [], finishReason: 'length' }],
      toolCalls: [],
      toolResults: [],
    }));

    const callbacks = makeCallbacks();
    await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onCompleted).toHaveBeenCalledWith(expect.stringContaining("Cut off at the model's output limit"), expect.anything(), expect.anything());
  });

  it('denies tools still requested on the last step so the conversation stays valid to reply to', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    const step = { toolCalls: [{ toolName: 'srv1__send' }], toolResults: [] };
    const approvedResult = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'srv1__send', output: { type: 'text', value: 'sent' } }] };
    streamTextMock
      .mockImplementationOnce(() => makeStreamResult({
        text: '', steps: Array.from({ length: 29 }, () => step), toolCalls: [], toolResults: [],
        streamParts: [makeApprovalRequest('approval-1', 'call-1', 'srv1__send', {})],
      }))
      // The model ignores `toolChoice: none` on the final step and asks again.
      .mockImplementationOnce(() => makeStreamResult({
        text: '', steps: [step], toolCalls: [], toolResults: [],
        streamParts: [makeApprovalRequest('approval-2', 'call-2', 'srv1__send', {})],
        responseMessages: [approvedResult, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-2', toolName: 'srv1__send', input: {} }] }],
      }));

    const messages = await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, makeCallbacks());

    expect(messages).toContainEqual(approvedResult);
    expect(messages?.at(-1)).toMatchObject({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-2', output: { type: 'execution-denied' } }] });
  });

  it('closes a tool call cut off at the output limit so the conversation stays valid to reply to', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    // The SDK skips tools when a step ends at the output limit, but keeps the call in the response.
    streamTextMock.mockImplementation(() => makeStreamResult({
      text: '', steps: [{ toolCalls: [{ toolName: 'srv1__search' }], toolResults: [], finishReason: 'length' }], toolCalls: [], toolResults: [],
      responseMessages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'srv1__search', input: {} }] }],
    }));

    const messages = await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, makeCallbacks());

    expect(messages?.at(-1)).toMatchObject({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', output: { type: 'execution-denied' } }] });
  });

  it('continues a previous conversation by sending its messages before the new command', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    const answer = { role: 'assistant', content: 'Which city?' };
    streamTextMock.mockImplementation(() => makeStreamResult({
      text: 'Which city?', steps: [{ toolCalls: [], toolResults: [] }], toolCalls: [], toolResults: [], responseMessages: [answer],
    }));
    const signal = new AbortController().signal;

    const conversation = await runAgent('run-1', 'weather', baseConfig as never, {}, signal, makeCallbacks());
    await runAgent('run-2', 'Pune', baseConfig as never, {}, signal, makeCallbacks(), undefined, undefined, conversation ?? []);

    // The loop appends each response to the array it passed in, so compare only what was sent.
    expect(streamTextMock.mock.calls[1]?.[0].messages.slice(0, 3)).toEqual([
      { role: 'user', content: expect.stringContaining('\n\nweather') },
      answer,
      { role: 'user', content: expect.stringContaining('\n\nPune') },
    ]);
  });

  it('resumes the model with a denied tool approval response', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock
      .mockImplementationOnce(() => makeStreamResult({
        text: '',
        steps: [],
        toolCalls: [],
        toolResults: [],
        streamParts: [makeApprovalRequest('approval-1', 'call-1', 'srv1__send', { to: 'a@example.com' })],
        responseMessages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'call-1', toolName: 'srv1__send', input: { to: 'a@example.com' } },
              { type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'call-1' },
            ],
          },
        ],
      }))
      .mockImplementationOnce(() => makeStreamResult({
        text: 'I will not send it.',
        steps: [],
        toolCalls: [],
        toolResults: [],
      }));

    const callbacks = makeCallbacks();
    callbacks.requestToolApproval.mockImplementation(async () => ({
      approved: false,
      message: 'Use US instead.',
    }));

    await runAgent('run-1', 'send the email', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(callbacks.requestToolApproval).toHaveBeenCalledWith({
      serverId: 'srv1',
      toolName: 'send',
      modelToolName: 'srv1__send',
      arguments: { to: 'a@example.com' },
    });
    expect(streamTextMock.mock.calls[1]?.[0].messages).toEqual([
      { role: 'user', content: expect.stringContaining('\n\nsend the email') },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'srv1__send', input: { to: 'a@example.com' } },
          { type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'call-1' },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-approval-response',
            approvalId: 'approval-1',
            approved: false,
            reason: 'Use US instead.',
          },
        ],
      },
    ]);
    expect(callbacks.onCompleted).toHaveBeenCalledWith('I will not send it.', [], expect.anything());
  });

  it('prompts for multiple approval requests sequentially and resumes once with batched responses', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock
      .mockImplementationOnce(() => makeStreamResult({
        text: '',
        steps: [],
        toolCalls: [],
        toolResults: [],
        streamParts: [
          makeApprovalRequest('approval-1', 'call-1', 'srv1__send', { to: 'a@example.com' }),
          makeApprovalRequest('approval-2', 'call-2', 'srv1__delete', { id: 'msg-1' }),
        ],
        responseMessages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'call-1', toolName: 'srv1__send', input: { to: 'a@example.com' } },
              { type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'call-1' },
              { type: 'tool-call', toolCallId: 'call-2', toolName: 'srv1__delete', input: { id: 'msg-1' } },
              { type: 'tool-approval-request', approvalId: 'approval-2', toolCallId: 'call-2' },
            ],
          },
        ],
      }))
      .mockImplementationOnce(() => makeStreamResult({
        text: 'Handled decisions.',
        steps: [],
        toolCalls: [],
        toolResults: [],
      }));

    const callbacks = makeCallbacks();
    callbacks.requestToolApproval
      .mockImplementationOnce(async () => ({ approved: true }))
      .mockImplementationOnce(async () => ({ approved: false, message: 'Do not delete.' }));

    await runAgent('run-1', 'send and delete', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.requestToolApproval).toHaveBeenNthCalledWith(1, {
      serverId: 'srv1',
      toolName: 'send',
      modelToolName: 'srv1__send',
      arguments: { to: 'a@example.com' },
    });
    expect(callbacks.requestToolApproval).toHaveBeenNthCalledWith(2, {
      serverId: 'srv1',
      toolName: 'delete',
      modelToolName: 'srv1__delete',
      arguments: { id: 'msg-1' },
    });
    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(streamTextMock.mock.calls[1]?.[0].messages.at(-1)).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId: 'approval-1',
          approved: true,
          reason: 'User approved tool execution.',
        },
        {
          type: 'tool-approval-response',
          approvalId: 'approval-2',
          approved: false,
          reason: 'Do not delete.',
        },
      ],
    });
  });

  it('keeps what the model said before a tool call as a step, apart from the answer', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock.mockImplementation(() => makeStreamResult({
      text: 'Sunny.',
      steps: [
        { toolCalls: [{ toolName: 'srv1__search' }], toolResults: [] },
        { toolCalls: [], toolResults: [] },
      ],
      toolCalls: [],
      toolResults: [],
      streamParts: [
        { type: 'start-step' },
        { type: 'text-delta', text: 'Let me check.' },
        { type: 'tool-call', toolName: 'srv1__search' },
        { type: 'start-step' },
        { type: 'text-delta', text: 'Sunny.' },
      ],
    }));

    const callbacks = makeCallbacks();
    await runAgent('run-1', 'weather?', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onCompleted).toHaveBeenCalledWith('Sunny.', [], [{ text: 'Let me check.', tools: ['search'] }]);
  });

  it('reports each streamed text delta as the live step', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock.mockReturnValue({
      text: Promise.resolve('Hello world'),
      stream: toAsyncIterable([
        { type: 'text-delta', text: 'Hello' },
        { type: 'text-delta', text: ' world' },
      ]),
      responseMessages: Promise.resolve([]),
      steps: Promise.resolve([]),
      toolCalls: Promise.resolve([]),
      toolResults: Promise.resolve([]),
    });

    const callbacks = makeCallbacks();
    const seen: unknown[] = [];
    callbacks.onSteps.mockImplementation((steps: unknown) => { seen.push(structuredClone(steps)); });
    await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(seen).toEqual([[{ text: 'Hello', tools: [] }], [{ text: 'Hello world', tools: [] }]]);
    expect(callbacks.onCompleted).toHaveBeenCalledWith('Hello world', [], []);
  });

  it('ignores blank streamed text deltas so the UI does not show an empty streaming toast', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    streamTextMock.mockImplementation(() => makeStreamResult({
      text: 'Ready',
      steps: [],
      toolCalls: [],
      toolResults: [],
      streamChunks: ['   ', '\n', 'Ready'],
    }));

    const callbacks = makeCallbacks();

    await runAgent('run-1', 'hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onSteps).toHaveBeenCalledTimes(1);
    expect(callbacks.onSteps).toHaveBeenCalledWith([{ text: 'Ready', tools: [] }]);
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
      responseMessages: Promise.resolve([]),
      toolCalls: Promise.resolve([]),
      toolResults: Promise.resolve([]),
    });

    const callbacks = makeCallbacks();
    await runAgent('run-1', 'say hello', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onAudit).toHaveBeenCalledWith('empty_response_degraded', {
      toolNames: [],
      hadToolActivity: false,
    });
    expect(callbacks.onCompleted).toHaveBeenCalledWith(
      'The agent completed, but returned an empty response.',
      [],
      [],
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
      responseMessages: Promise.resolve([]),
      toolCalls: Promise.resolve([{ toolName: 'srv1__search' }]),
      toolResults: Promise.resolve([{ toolName: 'srv1__search', result: 'ok' }]),
    });

    const callbacks = makeCallbacks();
    await runAgent('run-1', 'search web', baseConfig as never, {}, new AbortController().signal, callbacks);

    expect(callbacks.onAudit).toHaveBeenCalledWith('empty_response_degraded', {
      toolNames: ['srv1__search'],
      hadToolActivity: true,
    });
    expect(callbacks.onCompleted).toHaveBeenCalledWith(
      'The agent completed tool work but returned no final text.',
      [],
      [],
    );
  });

});

function makeCallbacks(): AgentRuntimeCallbacks & { [K in keyof AgentRuntimeCallbacks]: ReturnType<typeof mock> } {
  return {
    onStatus: mock(() => undefined),
    onSteps: mock(() => undefined),
    onCompleted: mock(() => undefined),
    onFailed: mock(() => undefined),
    onCancelled: mock(() => undefined),
    requestToolApproval: mock(async () => ({ approved: true })),
    onAudit: mock(() => undefined),
  };
}

function makeStreamResult(result: {
  text: string;
  steps: Array<{ toolCalls: Array<{ toolName: string }>; toolResults: unknown[]; finishReason?: string }>;
  toolCalls: unknown[];
  toolResults: unknown[];
  streamChunks?: string[];
  streamParts?: Array<{ type: string; text?: string; toolName?: string; error?: unknown; approvalId?: string; toolCall?: { toolName: string; input: unknown } }>;
  responseMessages?: unknown[];
}) {
  const streamParts = result.streamParts ?? result.streamChunks?.map((text) => ({ type: 'text-delta', text })) ?? undefined;
  return {
    text: Promise.resolve(result.text),
    stream: streamParts ? toAsyncIterable(streamParts) : undefined,
    responseMessages: Promise.resolve(result.responseMessages ?? []),
    steps: Promise.resolve(result.steps),
    toolCalls: Promise.resolve(result.toolCalls),
    toolResults: Promise.resolve(result.toolResults),
  };
}

function makeApprovalRequest(approvalId: string, toolCallId: string, toolName: string, input: unknown) {
  return {
    type: 'tool-approval-request',
    approvalId,
    toolCall: { toolCallId, toolName, input },
  };
}

async function* toAsyncIterable<T>(chunks: T[]): AsyncIterable<T> {
  for (const chunk of chunks) yield chunk;
}
