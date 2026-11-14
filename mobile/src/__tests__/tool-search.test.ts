import { describe, expect, it } from 'bun:test';
import { simulateReadableStream, tool, type Tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { runAgentLoop, TOOL_SEARCH_TOOL } from '@shuddhalekhan/shared/agent-loop';

type StreamPart = { type: 'tool-call'; toolCallId: string; toolName: string; input: string } | { type: 'text-delta'; id: string; delta: string };

function reply(part: StreamPart) {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
  const finishReason = { unified: part.type === 'tool-call' ? 'tool-calls' as const : 'stop' as const, raw: undefined };
  const text = part.type === 'text-delta' ? [{ type: 'text-start' as const, id: part.id }, part, { type: 'text-end' as const, id: part.id }] : [part];
  return { stream: simulateReadableStream({ chunks: [{ type: 'stream-start' as const, warnings: [] }, ...text, { type: 'finish' as const, finishReason, usage }] }) };
}

describe('tool search', () => {
  it('keeps deferred MCP tools out of the request and keeps a found tool loaded across an approval pause', async () => {
    const tools: Record<string, Tool> = {
      notes: tool({ description: 'Built-in notes.', inputSchema: z.object({}), execute: async () => 'none' }),
      weather__forecast: tool({ description: 'Get the weather forecast for a city.', inputSchema: z.object({ city: z.string() }), deferLoading: true, needsApproval: true, execute: async () => 'Rain' }),
      // Found by the same search but never called: only the search result keeps it loaded.
      weather__alerts: tool({ description: 'Get weather alerts for a city.', inputSchema: z.object({ city: z.string() }), deferLoading: true, execute: async () => 'None' }),
    };
    for (let index = 0; index < 10; index++) {
      tools[`other__tool_${index}`] = tool({ description: 'Unrelated.', inputSchema: z.object({}), deferLoading: true, execute: async () => '' });
    }
    const replies = [
      reply({ type: 'tool-call', toolCallId: 'search-1', toolName: TOOL_SEARCH_TOOL, input: '{"query":"weather"}' }),
      reply({ type: 'tool-call', toolCallId: 'forecast-1', toolName: 'weather__forecast', input: '{"city":"Pune"}' }),
      reply({ type: 'text-delta', id: 'answer', delta: 'Rain in Pune.' }),
    ];
    const model = new MockLanguageModelV4({ doStream: async () => replies.shift() ?? reply({ type: 'text-delta', id: 'extra', delta: '' }) });
    const approvals: string[] = [];

    const result = await runAgentLoop({
      client: { model, providerOptions: {} },
      instructions: 'Test.',
      messages: [{ role: 'user', content: 'Will it rain in Pune?' }],
      tools,
      signal: new AbortController().signal,
      onStatus: () => {},
      requestToolApproval: async request => { approvals.push(request.modelToolName); return { approved: true }; },
    });

    const sentTools = model.doStreamCalls.map(call => call.tools?.map(item => item.name).sort());
    expect(result.text).toBe('Rain in Pune.');
    expect(approvals).toEqual(['weather__forecast']);
    expect(sentTools[0]).toEqual(['notes', TOOL_SEARCH_TOOL]);
    // The third call is a new generation after the approval pause; the SDK alone would have forgotten the search.
    expect(sentTools[2]).toEqual(['notes', TOOL_SEARCH_TOOL, 'weather__alerts', 'weather__forecast']);
  });
});
