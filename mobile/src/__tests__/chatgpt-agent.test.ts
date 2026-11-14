import { expect, test } from 'bun:test';
import { z } from 'zod';
import { runAgent } from '../agent';
import { defaultSettings } from '../settings';
import { selectAgentProvider } from '../providers';
import { responsesReply } from './model-stream';

// Request shaping (developer prompt, stripped fields, include fallback) is shared with desktop and covered by
// app/src/agent/__tests__/fixtures/provider-contract.ts. These cover the iOS transport and its error messages.
// A reasoning model: only those get `include`, which the plan may reject.
const settings = { ...selectAgentProvider(defaultSettings, 'chatgpt'), agentEnabled: true, agentModel: 'gpt-5.4' };
const requestSchema = z.object({ model: z.string(), stream: z.boolean(), store: z.boolean(), include: z.array(z.string()).optional() }).passthrough();
const rejection = (status: number, error: Record<string, string>) =>
  // The SDK retries 429 and 5xx; a zero retry-after keeps those cases fast.
  Response.json({ error }, { status, headers: { 'retry-after-ms': '0' } });

function run(fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  let issued = 0;
  return runAgent({ transcript: 'Hello.', settings, signal: new AbortController().signal,
    fetch: Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }),
    onStatus: () => {}, approve: async () => true, getChatGptAccessToken: async () => `token-${++issued}` });
}

test('every plan request goes to the ChatGPT endpoint with a freshly read token and no redirects', async () => {
  const requests: Array<{ url: string; authorization: string | null; redirect?: RequestRedirect; body: z.infer<typeof requestSchema> }> = [];
  const { text } = await run(async (input, init) => {
    const body = requestSchema.parse(JSON.parse(String(init?.body)));
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect, body });
    return requests.length === 1
      ? rejection(400, { param: 'include', code: 'subscription_sharing_unsupported_capability' })
      : responsesReply('Final café answer.');
  });
  expect(text).toBe('Final café answer.');
  expect(requests.map(({ url, authorization, redirect }) => ({ url, authorization, redirect }))).toEqual([
    { url: 'https://api.openai.com/v1/responses', authorization: 'Bearer token-1', redirect: 'error' },
    { url: 'https://api.openai.com/v1/responses', authorization: 'Bearer token-2', redirect: 'error' },
  ]);
  expect(requests[0]?.body).toMatchObject({ model: 'gpt-5.4', stream: true, store: false, include: ['reasoning.encrypted_content'] });
  expect(requests[1]?.body).not.toHaveProperty('include');
});

test('does not retry unrelated 400s or retry include more than once', async () => {
  for (const param of ['model', 'include']) {
    let calls = 0;
    await expect(run(async () => {
      calls++;
      return rejection(400, { param, code: 'subscription_sharing_unsupported_capability' });
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
  const failure = run(async () => rejection(status, { code, message: 'SECRET provider details' }));
  await expect(failure).rejects.toThrow(message);
  await expect(failure).rejects.not.toThrow('SECRET');
});
