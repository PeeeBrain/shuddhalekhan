import assert from 'node:assert/strict';
import { z } from 'zod';
import { streamText, tool } from 'ai';
import { createAgentProvider } from '../../provider';
import { testAgentProvider } from '../../provider-test';
import { providerDiagnostic } from '../../provider-diagnostic';
import { runAgent } from '../../runtime';
import type { AgentProviderConfig } from '../../../types/ipc';

const apiKey = 'fake-azure-key-without-sk-prefix';
process.env.PROVIDER_CONTRACT_KEY = apiKey;
let captures: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
let mode: 'text' | 'tools' | 'cache-loop' | 'no-cache-metrics' | 'no-tool' | 'auth-error' | 'stall' | 'length' | 'tool-preamble-only' = 'text';
const reasoningDetails = [{ type: 'reasoning.encrypted', data: 'opaque-test-data', id: 'reason-1', format: 'anthropic-claude-v1', index: 0 }];
const messagesSchema = z.object({ messages: z.array(z.object({ role: z.string(), reasoning_details: z.unknown().optional() })).optional() });
const cacheCount = (body: Record<string, unknown>) => (JSON.stringify(body).match(/"(?:cache_control|prompt_cache_breakpoint)"/g) ?? []).length;

globalThis.fetch = async (input, init) => {
  const body = z.record(z.string(), z.unknown()).parse(JSON.parse(String(init?.body)));
  const url = String(input);
  captures.push({ url, headers: new Headers(init?.headers), body });
  assert.equal(init?.redirect, 'error');
  if (body.model === 'old-cache-model' && cacheCount(body)) {
    return Response.json({ error: { message: 'prompt_cache_breakpoint is not supported' } }, { status: 400 });
  }
  if (url.includes('resource.openai.azure.com') && body.max_tokens !== undefined) {
    return Response.json({ error: { message: 'This deployment requires max_completion_tokens, not max_tokens.', code: 'unsupported_parameter' } }, { status: 400 });
  }
  if (mode === 'auth-error') return Response.json({ error: { message: `Wrong key: ${apiKey}`, code: 'invalid_api_key' } }, { status: 401, headers: { 'apim-request-id': 'azure-request-1' } });
  if (mode === 'stall') return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  if (url.endsWith('/responses')) {
    const inputItems = z.array(z.object({ type: z.string().optional() })).parse(body.input);
    const outputCount = inputItems.filter(item => item.type === 'function_call_output').length;
    const toolCall = body.tools && (mode === 'cache-loop' ? outputCount < 3 : mode === 'tools' && outputCount === 0);
    const event = (value: { type: string; [key: string]: unknown }) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
    let events = event({ type: 'response.created', response: { id: 'resp-1', created_at: 1, model: body.model } });
    if (toolCall) {
      const reasoning = { type: 'reasoning', id: 'reason-1', encrypted_content: 'opaque-response-reasoning' };
      const call = { type: 'function_call', id: 'function-1', call_id: 'call-1', name: 'provider_check_echo', arguments: '{"value":"shuddhalekhan-provider-check"}', status: 'completed' };
      events += event({ type: 'response.output_item.added', output_index: 0, item: reasoning });
      events += event({ type: 'response.output_item.done', output_index: 0, item: reasoning });
      events += event({ type: 'response.output_item.added', output_index: 1, item: call });
      events += event({ type: 'response.output_item.done', output_index: 1, item: call });
    } else {
      const message = { type: 'message', id: 'message-1' };
      events += event({ type: 'response.output_item.added', output_index: 0, item: message });
      events += event({ type: 'response.output_text.delta', item_id: 'message-1', output_index: 0, delta: 'OK' });
      events += event({ type: 'response.output_item.done', output_index: 0, item: message });
    }
    events += event({ type: 'response.completed', response: { incomplete_details: null, usage: { input_tokens: 1280, output_tokens: 1, total_tokens: 1281, input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 128 } } } });
    return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
  }
  const messages = messagesSchema.parse(body).messages ?? [];
  const toolResultCount = messages.filter(message => message.role === 'tool').length;
  const isToolRequest = body.tools && (mode === 'cache-loop' ? toolResultCount < 9
    : (mode === 'tools' || mode === 'tool-preamble-only') && toolResultCount === 0);
  const delta = isToolRequest ? {
    ...(mode === 'tool-preamble-only' ? { content: 'Checking the tool.' } : {}),
    reasoning_details: reasoningDetails,
    tool_calls: Array.from({ length: mode === 'cache-loop' ? 3 : 1 }, (_, index) => ({ index, id: `call-${toolResultCount + index + 1}`, type: 'function', function: { name: 'provider_check_echo', arguments: '{"value":"shuddhalekhan-provider-check"}' } })),
  } : mode === 'length' ? { reasoning_content: 'Still thinking.' }
    : mode === 'tool-preamble-only' && messages.some(message => message.role === 'tool') ? { content: '' } : { content: 'OK' };
  const event = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'test-completion', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const usage = { prompt_tokens: 1280, completion_tokens: 1, total_tokens: 1281,
    ...(mode === 'no-cache-metrics' ? {} : url.includes('api.deepseek.com') ? { prompt_cache_hit_tokens: 1024, prompt_cache_miss_tokens: 256 }
      : { prompt_tokens_details: { cached_tokens: 1024, cache_write_tokens: 128 } }) };
  return new Response(event(delta, null) + event({}, mode === 'length' ? 'length' : isToolRequest ? 'tool_calls' : 'stop')
    + `data: ${JSON.stringify({ choices: [], usage })}\n\n` + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
};

const profile: AgentProviderConfig = {
  kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiMode: 'chat-completions',
  model: 'gpt-5-mini', auth: 'bearer', apiKeySource: 'environment', apiKeyEnvVar: 'PROVIDER_CONTRACT_KEY', reasoning: 'high',
};

async function capture(provider: AgentProviderConfig) {
  captures = [];
  const client = createAgentProvider(provider, undefined, 'contract-session');
  const result = streamText({ model: client.model, providerOptions: client.providerOptions,
    instructions: { role: 'system', content: 'Stable test instructions.', providerOptions: client.cacheMessageOptions },
    prepareStep: client.prepareStep, prompt: 'Reply OK', maxRetries: 0, onError: () => undefined });
  let error: unknown;
  for await (const part of result.stream) if (part.type === 'error') error = part.error;
  if (error) assert.match(String(error), /intentional request-capture rejection/);
  else assert.equal(await result.text, 'OK');
  assert.equal(captures.length, 1);
  return captures[0];
}

const openai = await capture(profile);
assert.equal(openai.url, 'https://api.openai.com/v1/chat/completions');
assert.equal(openai.body.reasoning_effort, 'high');
assert.equal(openai.body.reasoning, undefined);
assert.equal(openai.headers.get('authorization'), `Bearer ${apiKey}`);
assert.equal(cacheCount(openai.body), 0);
assert.equal(openai.body.prompt_cache_key, undefined);
const azureProfile: AgentProviderConfig = { ...profile, kind: 'azure-openai', baseUrl: 'https://resource.openai.azure.com/openai/v1/', model: 'production', auth: 'api-key' };
const azure = await capture(azureProfile);
assert.equal(azure.body.model, 'production');
assert.equal(azure.body.reasoning_effort, 'high');
assert.equal(azure.headers.get('api-key'), apiKey);
assert.equal(azure.headers.get('authorization'), null);
assert.equal(cacheCount(azure.body), 0);
for (const provider of [profile, azureProfile]) {
  const request = await capture({ ...provider, apiMode: 'responses' });
  assert.ok(request.url.endsWith('/responses'));
  assert.deepEqual(request.body.reasoning, { effort: 'high' });
  assert.equal(request.body.store, false);
  assert.ok(Array.isArray(request.body.include) && request.body.include.includes('reasoning.encrypted_content'));
  for (const apiMode of ['chat-completions', 'responses'] as const) {
    const cacheRequest = await capture({ ...provider, apiMode, cacheBreakpoints: true });
    assert.equal(cacheRequest.body.prompt_cache_key, 'shuddhalekhan-agent-v1');
    assert.equal(cacheCount(cacheRequest.body), 2, JSON.stringify({ kind: provider.kind, apiMode, messages: cacheRequest.body.messages, input: cacheRequest.body.input }));
    assert.equal(cacheRequest.body.prompt_cache_options, undefined);
    assert.equal(cacheRequest.body.prompt_cache_retention, undefined);
  }
}

const local: AgentProviderConfig = { kind: 'openai-compatible', baseUrl: 'http://[::1]:11434/v1', model: 'local-model', auth: 'none', apiKeyEnvVar: '', reasoning: 'default' };
const localRequest = await capture(local);
assert.equal(localRequest.headers.get('authorization'), null);
assert.equal(localRequest.headers.get('api-key'), null);
assert.equal(localRequest.body.reasoning_effort, undefined);
assert.equal(cacheCount(localRequest.body), 0);
assert.equal((await capture({ ...local, cacheBreakpoints: true })).body.prompt_cache_key, undefined);
const keyed = await capture({ ...local, auth: 'api-key', apiKeyEnvVar: 'PROVIDER_CONTRACT_KEY' });
assert.equal(keyed.headers.get('api-key'), apiKey);
const none = await capture({ ...profile, reasoning: 'none' });
assert.equal(none.body.reasoning_effort, 'none');
const deepseek = await capture({ ...profile, kind: 'openai-compatible', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4-pro', reasoning: 'high' });
assert.deepEqual(deepseek.body.thinking, { type: 'enabled' });
assert.equal(deepseek.body.reasoning_effort, 'high');
assert.equal(deepseek.headers.get('x-opencode-session'), 'contract-session');
const lookalike = await capture({ ...local, baseUrl: 'https://opencode.ai.lookalike.invalid/v1' });
assert.equal(lookalike.headers.get('x-opencode-session'), null);
assert.equal(lookalike.body.thinking, undefined);

captures = [];
mode = 'no-cache-metrics';
let missingUsage: Record<string, unknown> | undefined;
await runAgent('no-cache-metrics', 'Reply OK', { agent: { enabled: true, provider: local, mcpServers: [] } }, {}, new AbortController().signal, {
  onStatus() {}, onResponseDelta() {}, onCompleted() {}, onFailed(error) { throw new Error(error); }, onCancelled() {},
  requestToolApproval: async () => ({ approved: true }),
  onAudit(type, payload) { if (type === 'provider_usage') missingUsage = payload; },
});
assert.equal(missingUsage?.inputTokens, 1280);
assert.equal(missingUsage?.cacheReadTokens, undefined);
assert.equal(missingUsage?.cacheWriteTokens, undefined);
mode = 'tools';
captures = [];
const router = { ...profile, kind: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/test-model' };
const checked = await testAgentProvider(router, new AbortController().signal);
assert.equal(checked.streaming.status, 'passed');
assert.equal(checked.tools.status, 'passed');
assert.equal(captures.length, 3);
assert.ok(captures.every(request => request.body.session_id === 'provider-check' && cacheCount(request.body) >= 2));
const continuation = messagesSchema.parse(captures[2].body).messages?.find(message => message.role === 'assistant');
assert.deepEqual(continuation?.reasoning_details, reasoningDetails);
assert.equal(JSON.stringify(checked).includes(apiKey), false);

for (const provider of [profile, azureProfile]) {
  captures = [];
  const checkedResponses = await testAgentProvider({ ...provider, apiMode: 'responses' }, new AbortController().signal);
  assert.deepEqual([checkedResponses.streaming.status, checkedResponses.tools.status], ['passed', 'passed']);
  assert.equal(captures.length, 3);
  const input = z.array(z.object({ type: z.string().optional(), encrypted_content: z.string().optional() })).parse(captures[2].body.input);
  assert.equal(input.find(item => item.type === 'reasoning')?.encrypted_content, 'opaque-response-reasoning');
}

for (const provider of [router, { ...azureProfile, apiMode: 'responses' as const, cacheBreakpoints: true }]) {
  captures = [];
  let approvals = 0;
  let executions = 0;
  let completed = '';
  const echo = tool({ inputSchema: z.object({ value: z.literal('shuddhalekhan-provider-check') }), needsApproval: true,
    execute: async ({ value }) => { executions++; return { value }; } });
  await runAgent('approval-contract', 'Call the test tool.', { agent: { enabled: true, provider, mcpServers: [] } },
    { provider_check_echo: echo }, new AbortController().signal, {
      onStatus() {}, onResponseDelta() {}, onCompleted(text) { completed = text; },
      onFailed(error) { throw new Error(error); }, onCancelled() { throw new Error('Unexpected cancellation'); },
      requestToolApproval: async () => { approvals++; return { approved: true }; },
    });
  assert.equal(approvals, 1);
  assert.equal(executions, 1);
  assert.equal(completed, 'OK');
  assert.equal(captures.length, 2);
  assert.ok(captures.every(request => cacheCount(request.body) > 0 && cacheCount(request.body) <= 3));
}

mode = 'cache-loop';
for (const provider of [router, ...[profile, azureProfile].flatMap(provider => (['chat-completions', 'responses'] as const).map(apiMode => ({ ...provider, apiMode, cacheBreakpoints: true } satisfies AgentProviderConfig)))]) {
  captures = [];
  const usage: Array<Record<string, unknown> | undefined> = [];
  const echo = tool({ inputSchema: z.object({ value: z.literal('shuddhalekhan-provider-check') }), execute: ({ value }) => ({ value }) });
  await runAgent('cache-loop-session', 'Call the test tool.', { agent: { enabled: true, provider, mcpServers: [] } },
    { z_test: echo, provider_check_echo: echo, a_test: echo }, new AbortController().signal, {
      onStatus() {}, onResponseDelta() {}, onCompleted(text) { assert.equal(text, 'OK'); },
      onFailed(error) { throw new Error(error); }, onCancelled() { throw new Error('Unexpected cancellation'); },
      requestToolApproval: async () => ({ approved: true }),
      onAudit(type, payload) { if (type === 'provider_usage') usage.push(payload); },
    });
  assert.equal(captures.length, 4);
  assert.ok(captures.every(request => cacheCount(request.body) >= 2 && cacheCount(request.body) <= 3));
  const definitions = z.array(z.object({ name: z.string().optional(), function: z.object({ name: z.string() }).optional() })).parse(captures[0].body.tools);
  assert.deepEqual(definitions.map(item => item.name ?? item.function?.name), ['a_test', 'provider_check_echo', 'z_test']);
  assert.equal(usage.length, 4);
  assert.ok(usage.every(step => step?.inputTokens === 1280 && step?.cacheReadTokens === 1024 && step?.cacheWriteTokens === 128));
  if (provider.kind === 'openrouter') assert.ok(captures.every(request => request.body.session_id === 'cache-loop-session'));
}
mode = 'text';
let previousPrefix: unknown;
for (const provider of [profile, azureProfile, router, { ...local, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' }]) {
  captures = [];
  let cacheRead: unknown;
  await runAgent('cache-prefix-session', 'A different command.', { agent: { enabled: true, provider, mcpServers: [] } }, {}, new AbortController().signal, {
    onStatus() {}, onResponseDelta() {}, onCompleted() {}, onFailed(error) { throw new Error(error); }, onCancelled() {},
    requestToolApproval: async () => ({ approved: true }),
    onAudit(type, payload) { if (type === 'provider_usage') cacheRead = payload?.cacheReadTokens; },
  });
  const messages = z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ text: z.string() }))]) })).parse(captures[0].body.messages);
  const system = messages[0].content;
  const prefix = typeof system === 'string' ? system : system[0].text;
  assert.ok(!prefix.includes('<runtime_context>'));
  if (previousPrefix !== undefined) assert.equal(prefix, previousPrefix);
  previousPrefix = prefix;
  const command = messages[1].content;
  assert.match(typeof command === 'string' ? command : command[0].text, /<runtime_context>/);
  assert.equal(cacheRead, 1024);
}
mode = 'tools';
const unsupportedCache = await testAgentProvider({ ...azureProfile, model: 'old-cache-model', cacheBreakpoints: true }, new AbortController().signal);
assert.equal(unsupportedCache.diagnostic?.kind, 'unsupported');
assert.equal(unsupportedCache.diagnostic?.statusCode, 400);
assert.equal((await testAgentProvider({ ...azureProfile, model: 'old-cache-model', cacheBreakpoints: false }, new AbortController().signal)).streaming.status, 'passed');
const defaultAzureChat = await testAgentProvider({ ...azureProfile, reasoning: 'default' }, new AbortController().signal);
assert.equal(defaultAzureChat.streaming.status, 'passed');
assert.equal(defaultAzureChat.tools.status, 'passed');

mode = 'no-tool';
assert.equal((await testAgentProvider(local, new AbortController().signal)).tools.status, 'inconclusive');
const ignored = await testAgentProvider({ ...profile, model: 'gpt-6-astra', reasoning: 'none' }, new AbortController().signal);
assert.equal(ignored.streaming.status, 'inconclusive');
assert.ok(ignored.warnings.some(warning => warning.includes('reasoning')));
mode = 'length';
assert.equal((await testAgentProvider(local, new AbortController().signal)).streaming.status, 'inconclusive');
mode = 'tool-preamble-only';
assert.equal((await testAgentProvider(local, new AbortController().signal)).tools.status, 'failed');
mode = 'auth-error';
const rejected = await testAgentProvider(azureProfile, new AbortController().signal);
assert.equal(rejected.diagnostic?.kind, 'authentication');
assert.equal(rejected.diagnostic?.statusCode, 401);
assert.equal(rejected.diagnostic?.requestId, 'azure-request-1');
assert.equal(JSON.stringify(rejected).includes(apiKey), false);
for (const [statusCode, kind] of [[403, 'permission'], [404, 'endpoint'], [400, 'unsupported'], [429, 'rate-limit']] as const) {
  assert.equal(providerDiagnostic({ statusCode, message: 'Fixture error' }).kind, kind);
}
assert.equal(providerDiagnostic({ statusCode: 429, responseBody: '{"error":{"code":"insufficient_quota"}}' }).kind, 'quota');
const cyclic: { message: string; cause?: unknown } = { message: apiKey };
cyclic.cause = cyclic;
assert.equal(providerDiagnostic(cyclic, apiKey).details, '[redacted]');

mode = 'stall';
const controller = new AbortController();
const cancelled = testAgentProvider(local, controller.signal);
controller.abort();
assert.equal((await cancelled).diagnostic?.kind, 'cancelled');
console.log('Provider contracts passed');
