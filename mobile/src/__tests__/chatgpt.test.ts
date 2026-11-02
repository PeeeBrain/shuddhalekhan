import { describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ChatGptAuth, type ChatGptNative } from '../chatgpt';

const now = 1_800_000_000_000;
const planScope = 'openid email chatgpt.tokens.use.direct';
const savedAccount = {
  clientId: 'registered-client', hostId: 'urn:uuid:2d3f9902-aec3-4ef9-8bce-03d583e16da7',
  identity: { issuer: 'https://auth.openai.com', subject: 'person-1', email: 'person@example.com' },
  account: { issuer: 'https://auth.openai.com', subject: 'person-1', email: 'person@example.com',
    refreshToken: 'old-refresh', scopes: planScope.split(' ') },
};
const storedSchema = z.object({ clientId: z.string().nullable(), hostId: z.string(),
  account: z.object({ refreshToken: z.string(), scopes: z.array(z.string()) }).nullable() });

function harness(options: { saved?: string; callback?: (url: URL) => string | null;
  claims?: Record<string, unknown>; scope?: string;
  tokenResponse?: (form: URLSearchParams) => Response | Promise<Response> } = {}) {
  let stored = options.saved ?? null;
  let authorize: URL | null = null;
  let clock = now;
  let cancelled = 0;
  const requests: { url: string; form: URLSearchParams; headers: Headers }[] = [];
  const native: ChatGptNative = {
    start: async () => 'http://127.0.0.1:52123/auth/callback',
    open: async value => {
      authorize = new URL(value);
      return options.callback ? options.callback(authorize)
        : `shuddhalekhan://chatgpt-auth?${new URLSearchParams({ state: authorize.searchParams.get('state')!, code: 'one-use-code', client_id: 'registered-client' })}`;
    },
    cancel: async () => { cancelled++; },
    random: async () => randomBytes(32).toString('base64url'),
    challenge: async value => createHash('sha256').update(value).digest('base64url'),
    hostId: async () => randomUUID(),
  };
  const auth = new ChatGptAuth({ native, now: () => clock,
    storage: { get: async () => stored, set: async value => { stored = value; }, remove: async () => { stored = null; } },
    fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      requests.push({ url, form, headers: new Headers(init?.headers) });
      if (url.endsWith('/revoke')) return new Response(null, { status: 200 });
      if (url.endsWith('/models')) return Response.json({ models: [
        { slug: 'shown', display_name: 'Shown model', visibility: 'list' },
        { slug: 'hidden', display_name: 'Hidden model', visibility: 'hidden' },
      ] });
      if (options.tokenResponse) return options.tokenResponse(form);
      const claims = { iss: 'https://auth.openai.com', sub: 'person-1', email: 'person@example.com',
        aud: 'registered-client', exp: now / 1000 + 3600, nonce: authorize?.searchParams.get('nonce'), ...options.claims };
      const idToken = `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
      return Response.json({ access_token: 'access-in-memory', refresh_token: form.get('grant_type') === 'refresh_token' ? 'rotated-refresh' : 'initial-refresh',
        expires_in: 3600, scope: options.scope ?? planScope, id_token: idToken });
    }, { preconnect: globalThis.fetch.preconnect }),
  });
  return { auth, requests, stored: () => stored, authorize: () => authorize, cancelled: () => cancelled,
    advance: (ms: number) => { clock += ms; } };
}

describe('ChatGPT authorization', () => {
  test.each([
    ['state mismatch', () => 'shuddhalekhan://chatgpt-auth?state=wrong&code=code&client_id=registered-client', 'state did not match'],
    ['duplicate state', (url: URL) => `shuddhalekhan://chatgpt-auth?state=${url.searchParams.get('state')}&state=other&code=code&client_id=registered-client`, 'duplicate'],
    ['duplicate code', (url: URL) => `shuddhalekhan://chatgpt-auth?state=${url.searchParams.get('state')}&code=one&code=two&client_id=registered-client`, 'duplicate'],
    ['duplicate unrelated key', (url: URL) => `shuddhalekhan://chatgpt-auth?state=${url.searchParams.get('state')}&code=one&client_id=registered-client&extra=a&extra=b`, 'duplicate'],
    ['access denied', (url: URL) => `shuddhalekhan://chatgpt-auth?state=${url.searchParams.get('state')}&error=access_denied`, 'denied'],
  ])('rejects %s before exchanging a code', async (_name, callback, message) => {
    const h = harness({ callback });
    await h.auth.signIn();
    expect(h.auth.getSnapshot()).toMatchObject({ status: 'signed-out', error: expect.stringContaining(message) });
    expect(h.requests).toHaveLength(0);
    expect(h.cancelled()).toBe(1);
  });

  test('registers with PKCE, persists the actual client and host, and stores no access or ID token', async () => {
    const h = harness();
    await h.auth.signIn();
    expect(h.auth.getSnapshot()).toEqual({ status: 'signed-in', email: 'person@example.com', planUsage: true, error: null });
    const authorize = h.authorize()!;
    expect(authorize.origin + authorize.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authorize.searchParams.get('agent_name_hint')).toBe('Shuddhalekhan');
    expect(authorize.searchParams.get('scope')).toBe('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
    const exchange = h.requests[0]!;
    expect(Object.fromEntries(exchange.form)).toMatchObject({ client_id: 'registered-client', grant_type: 'authorization_code',
      resource: 'https://api.openai.com/v1', redirect_uri: 'http://127.0.0.1:52123/auth/callback' });
    expect(exchange.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(authorize.searchParams.get('code_challenge')).toBe(createHash('sha256').update(exchange.form.get('code_verifier')!).digest('base64url'));
    const saved = storedSchema.parse(JSON.parse(h.stored()!));
    expect(saved.clientId).toBe('registered-client');
    expect(saved.hostId).toBe(authorize.searchParams.get('ext_agent_host_id')!);
    expect(h.stored()).not.toContain('access-in-memory');
    expect(h.stored()).not.toContain('idToken');
    expect(await h.auth.getAccessToken()).toBe('access-in-memory');
    expect(h.requests).toHaveLength(1);
    await h.auth.signIn();
    expect(h.authorize()!.searchParams.get('client_id')).toBe('registered-client');
    expect(h.authorize()!.searchParams.get('login_hint')).toBe('person@example.com');
    expect(h.authorize()!.searchParams.has('id_token_hint')).toBe(true);
    expect(h.authorize()!.searchParams.get('ext_agent_host_id')).toBe(saved.hostId);
  });

  test.each([
    { iss: 'https://wrong.example' }, { aud: 'wrong-client' }, { aud: ['registered-client', 'other'] },
    { azp: 'wrong-client' }, { exp: now / 1000 }, { nonce: 'wrong' }, { email: 'invalid' }, { sub: '' },
  ])('rejects invalid ID-token claims %j', async claims => {
    const h = harness({ claims });
    await h.auth.signIn();
    expect(h.auth.getSnapshot()).toMatchObject({ status: 'signed-out', error: expect.stringContaining('identity could not be verified') });
    expect(storedSchema.parse(JSON.parse(h.stored()!)).account).toBeNull();
  });

  test('accepts a multi-audience token only with the matching authorized party', async () => {
    const h = harness({ claims: { aud: ['registered-client', 'other'], azp: 'registered-client' } });
    await h.auth.signIn();
    expect(h.auth.getSnapshot().status).toBe('signed-in');
  });

  test('re-sign-in cannot change the subject attached to a saved registration', async () => {
    const h = harness({ saved: JSON.stringify(savedAccount), claims: { sub: 'other-person' } });
    await h.auth.signIn();
    expect(h.auth.getSnapshot().error).toContain('does not match');
    expect(h.stored()).toContain('person-1');
    expect(h.stored()).not.toContain('other-person');
  });

  test('browser cancellation resolves quietly and releases the listener', async () => {
    const h = harness({ callback: () => null });
    await h.auth.signIn();
    expect(h.auth.getSnapshot()).toMatchObject({ status: 'signed-out', error: null });
    expect(h.cancelled()).toBe(1);
  });
});

describe('ChatGPT session', () => {
  test('concurrent lazy refreshes rotate the token once and persist it before returning access', async () => {
    const h = harness({ saved: JSON.stringify(savedAccount) });
    const tokens = await Promise.all([h.auth.getAccessToken(), h.auth.getAccessToken()]);
    expect(tokens).toEqual(['access-in-memory', 'access-in-memory']);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.form.get('refresh_token')).toBe('old-refresh');
    expect(storedSchema.parse(JSON.parse(h.stored()!)).account?.refreshToken).toBe('rotated-refresh');
    await h.auth.getAccessToken();
    expect(h.requests).toHaveLength(1);
    h.advance(56 * 60_000);
    await h.auth.getAccessToken();
    expect(h.requests[1]!.form.get('refresh_token')).toBe('rotated-refresh');
  });

  test('an expired refresh grant clears the session and revokes the old refresh token', async () => {
    const h = harness({ saved: JSON.stringify(savedAccount), tokenResponse: () => Response.json({ error: 'invalid_grant' }, { status: 400 }) });
    await expect(h.auth.getAccessToken()).rejects.toThrow('Sign in with ChatGPT again');
    expect(h.auth.getSnapshot()).toMatchObject({ status: 'signed-out', email: null, planUsage: false });
    expect(storedSchema.parse(JSON.parse(h.stored()!)).account).toBeNull();
    expect(h.requests.at(-1)?.url).toBe('https://auth.openai.com/api/accounts/oauth/revoke');
    expect(h.requests.at(-1)?.form.get('token')).toBe('old-refresh');
  });

  test('sign-out wins over a refresh that completes late', async () => {
    const response = Promise.withResolvers<Response>();
    const entered = Promise.withResolvers<void>();
    const h = harness({ saved: JSON.stringify(savedAccount), tokenResponse: () => { entered.resolve(); return response.promise; } });
    const refresh = h.auth.getAccessToken();
    await entered.promise;
    await h.auth.signOut();
    response.resolve(Response.json({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600, scope: planScope }));
    await expect(refresh).rejects.toThrow('Sign in with ChatGPT again');
    expect(h.auth.getSnapshot().status).toBe('signed-out');
    expect(storedSchema.parse(JSON.parse(h.stored()!)).account).toBeNull();
  });

  test('missing plan scope gates inference and model discovery without making another request', async () => {
    const h = harness({ scope: 'openid email' });
    await h.auth.signIn();
    expect(h.auth.getSnapshot()).toMatchObject({ status: 'signed-in', planUsage: false });
    await expect(h.auth.getAccessToken()).rejects.toThrow('allow plan usage');
    await expect(h.auth.listModels()).rejects.toThrow('allow plan usage');
    expect(h.requests).toHaveLength(1);
  });

  test('a refreshed token losing plan scope is gated before it can be used', async () => {
    const h = harness({ saved: JSON.stringify(savedAccount), scope: 'openid email' });
    await expect(h.auth.getAccessToken()).rejects.toThrow('allow plan usage');
    expect(h.auth.getSnapshot().planUsage).toBe(false);
  });

  test('model discovery lists only visible models with a current bearer', async () => {
    const h = harness({ saved: JSON.stringify(savedAccount) });
    expect(await h.auth.listModels()).toEqual([{ id: 'shown', label: 'Shown model' }]);
    expect(h.requests.at(-1)?.headers.get('authorization')).toBe('Bearer access-in-memory');
  });
});
