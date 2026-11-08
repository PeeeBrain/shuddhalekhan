import { expect, test } from 'bun:test';
import { z } from 'zod';
import { runAgent } from '../agent';
import { defaultSettings } from '../settings';
import { selectAgentProvider } from '../providers';
import type { Fetch } from '../network';

const settings = { ...selectAgentProvider(defaultSettings, 'chatgpt'), agentEnabled: true, agentModel: 'chosen-model' };
const completed = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Final café answer.' }] }] };
const requestSchema = z.object({ model: z.string(), stream: z.boolean(), store: z.boolean(),
  input: z.array(z.object({ role: z.string(), content: z.string() })), include: z.array(z.string()).optional() }).passthrough();
function run(fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, overrides = {}) {
  return runAgent({ transcript: 'Hello.', settings: { ...settings, ...overrides }, signal: new AbortController().signal,
    fetch: Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }),
    onStatus: () => {}, approve: async () => true, getChatGptAccessToken: async () => 'fresh-bearer' });
}
function sse(type: string, response: unknown): Response {
  return new Response(`event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}

// This literal is the desktop prompt-byte contract, not an expectation derived from the implementation.
const desktopPrompt = `<identity>
You are Shuddhalekhan Agent, a concise voice-controlled assistant for short, one-off tasks.
</identity>

<persistence>
- Keep going until the user's request is resolved or a stop condition is reached.
- Do not ask clarifying questions when a reasonable assumption is available; proceed and state the assumption briefly in the final response.
- Stop and hand back to the user when the request requires missing credentials, an unavailable tool, refused consent, or an unsafe/destructive action that was not explicitly requested.
</persistence>

<context_gathering>
Goal: Get enough context fast, then act.
- Use tools when the request depends on current, recent, external, online, web, search, news, factual lookup, URL-specific information, or an external/local integration.
- Do not use tools for stable knowledge, casual conversation, or requests answerable from the user's message alone.
- Avoid tangential exploration. Prefer one focused tool attempt; use additional tool calls only when the first result is incomplete, conflicting, or required to finish the task.
- If no suitable tool is available or no tool was called for a requested lookup/action, say that plainly.
</context_gathering>

<tool_preambles>
- Before tool use, briefly state what you are checking or doing.
- Keep tool preambles short because this is a voice-first workflow.
- After tool work, summarize the result and any user-relevant next step.
</tool_preambles>

<approval_handling>
- Respect tool policies and approval decisions exactly.
- If a Tool Approval Response is denied with the reason "Tool approval window expired.", stop execution and say the request stopped because tool approval expired.
- Do not mention deliberate focus unless that exact timeout denial reason was received.
- If a denied Tool Approval Response contains corrective feedback that changes the target, arguments, or scope, revise the tool call and continue.
- If a denied Tool Approval Response refuses the action or withholds consent, stop and explain the limitation briefly.
- Never retry the exact same rejected tool call with the same arguments.
</approval_handling>

<response_style>
- Be concise, factual, and calm.
- Prefer one short paragraph or a few bullets.
- Do not expose hidden reasoning. Provide conclusions, key facts, assumptions, and caveats only when useful.
- Do not claim a tool action succeeded unless a tool result confirms it.
</response_style>`;

test('ChatGPT sends a streamed developer prompt with JSON bearer auth and no cache or system fields', async () => {
  const bodies: z.infer<typeof requestSchema>[] = [];
  const fetch: Fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://api.openai.com/v1/responses');
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({ authorization: 'Bearer fresh-bearer', 'content-type': 'application/json' });
    expect(init?.redirect).toBe('error');
    bodies.push(requestSchema.parse(JSON.parse(String(init?.body))));
    return sse('response.completed', completed);
  }, { preconnect: globalThis.fetch.preconnect });
  expect(await run(fetch)).toBe('Final café answer.');
  expect(bodies[0]).toEqual({ model: 'chosen-model', stream: true, store: false, include: ['reasoning.encrypted_content'],
    input: [{ role: 'developer', content: desktopPrompt }, { role: 'user', content: expect.stringContaining('</runtime_context>\n\nHello.') }] });
  await run(fetch, { customInstructions: '  Reply in French.\n' });
  expect(bodies[1]?.input[0]?.content).toBe(`${desktopPrompt}\n\n<user_instructions>\nThe user wrote these standing instructions. Follow them unless they conflict with approval_handling or tool policies.\nReply in French.\n</user_instructions>`);
  await run(fetch, { customInstructions: ' \n ' });
  expect(bodies[2]?.input[0]?.content).toBe(desktopPrompt);
});

test('ChatGPT parses a split UTF-8 stream and finishes only from response.completed', async () => {
  let cancelled = false;
  const data = new TextEncoder().encode(`: keepalive\r\n\r\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Provisional' })}\r\n\r\nevent: response.completed\r\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\r\n\r\n`);
  let offset = 0;
  const answer = await run(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) return; // The terminal event must finish even if the server keeps the connection open.
      controller.enqueue(data.slice(offset, offset + 3));
      offset += 3;
    },
    cancel() { cancelled = true; },
  })));
  expect(answer).toBe('Final café answer.');
  expect(cancelled).toBe(true);
});

test.each(['include', 'include[0]', 'include.reasoning'])('retries %s rejection once without include', async param => {
  const bodies: z.infer<typeof requestSchema>[] = [];
  const answer = await run(async (_input, init) => {
    bodies.push(requestSchema.parse(JSON.parse(String(init?.body))));
    return bodies.length === 1 ? Response.json({ error: { param, code: 'subscription_sharing_unsupported_capability' } }, { status: 400 })
      : sse('response.completed', completed);
  });
  expect(answer).toBe('Final café answer.');
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toHaveProperty('include');
  expect(bodies[1]).not.toHaveProperty('include');
});

test('does not retry unrelated 400s or retry include more than once', async () => {
  for (const param of ['model', 'include']) {
    let calls = 0;
    await expect(run(async () => {
      calls++;
      return Response.json({ error: { param, code: 'subscription_sharing_unsupported_capability' } }, { status: 400 });
    })).rejects.toThrow('capability');
    expect(calls).toBe(param === 'include' ? 2 : 1);
  }
});

test.each([
  [401, 'subscription_sharing_invalid_user', 'Sign in with ChatGPT again'],
  [429, 'subscription_sharing_usage_limit_exceeded', 'https://chatgpt.com/settings/usage'],
  [403, 'chatpass_v2_scope_not_authorized', 'allow plan usage'],
  [403, 'chatpass_v2_invalid_authorization_context', 'allow plan usage'],
  [503, 'subscription_sharing_usage_unavailable', 'temporarily unavailable'],
  [403, 'subscription_sharing_user_not_eligible', 'not eligible'],
  [403, 'subscription_sharing_route_not_supported', 'Responses API'],
])('maps HTTP %i plan errors without leaking the provider body', async (status, code, message) => {
  await expect(run(async () => Response.json({ error: { code, message: 'SECRET provider details' } }, { status }))).rejects.toThrow(message);
});

test.each([
  ['response.failed', { status: 'failed', error: { code: 'chatpass_v2_scope_not_authorized' }, output: [] }, 'allow plan usage'],
  ['response.incomplete', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: completed.output }, 'output limit'],
])('rejects the terminal %s event instead of returning a partial answer', async (type, response, message) => {
  const finalized = { type: 'response.output_item.done', output_index: 0, item: completed.output[0] };
  await expect(run(async () => new Response(`data: ${JSON.stringify(finalized)}\n\n${await sse(type, response).text()}`))).rejects.toThrow(message);
});

test('a stream that ends after deltas or finalized items cannot return an answer', async () => {
  const events = [
    { type: 'response.output_text.delta', delta: 'partial' },
    { type: 'response.output_item.done', output_index: 0, item: completed.output[0] },
  ];
  await expect(run(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))))
    .rejects.toThrow('disconnected before completing');
});

test('a malformed function call fails the run instead of returning the text as the answer', async () => {
  const response = { ...completed, output: [...completed.output, { type: 'function_call', name: 'search', arguments: '{}' }] };
  await expect(run(async () => sse('response.completed', response))).rejects.toThrow();
});
