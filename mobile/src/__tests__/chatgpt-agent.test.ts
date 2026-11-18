import { expect, test } from 'bun:test';
import { runAgent } from '../agent';
import { defaultSettings } from '../settings';
import { selectAgentProvider } from '../providers';
import { responsesReply } from './model-stream';

// Use a reasoning model so the provider can trigger a second request by rejecting include.
const settings = { ...selectAgentProvider(defaultSettings, 'chatgpt'), agentEnabled: true, agentModel: 'gpt-5.4' };
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
  const requests: Array<{ url: string; authorization: string | null; redirect?: RequestRedirect }> = [];
  const { text } = await run(async (input, init) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    return requests.length === 1
      ? rejection(400, { param: 'include', code: 'subscription_sharing_unsupported_capability' })
      : responsesReply('Final café answer.');
  });
  expect(text).toBe('Final café answer.');
  expect(requests).toEqual([
    { url: 'https://api.openai.com/v1/responses', authorization: 'Bearer token-1', redirect: 'error' },
    { url: 'https://api.openai.com/v1/responses', authorization: 'Bearer token-2', redirect: 'error' },
  ]);
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
  [403, 'chatpass_v2_invalid_authorization_context', 'allow plan usage'],
  [403, 'subscription_sharing_user_not_eligible', 'not eligible'],
  [403, 'subscription_sharing_route_not_supported', 'Responses API'],
  [503, 'subscription_sharing_usage_unavailable', 'temporarily unavailable'],
  [502, 'unexpected_error', 'ChatGPT could not complete the request (HTTP 502)'],
])('shows guidance for HTTP %i (%s) without leaking the provider body', async (status, code, message) => {
  const failure = run(async () => rejection(status, { code, message: 'SECRET provider details' }));
  await expect(failure).rejects.toThrow(message);
  await expect(failure).rejects.not.toThrow('SECRET');
});
