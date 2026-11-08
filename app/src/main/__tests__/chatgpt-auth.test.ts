import { expect, it } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { get } from 'node:http';
import { ChatGptAuth } from '../chatgpt-auth';
import type { ChatGptAccountStatus } from '../../types/ipc';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = 1_800_000_000_000;
const scope = 'openid email chatgpt.tokens.use.direct';

function fixture(options: { scope?: string; claims?: Record<string, unknown>; callback?: Record<string, string>;
  beforeCallback?: () => Promise<void>; badSignature?: boolean; exchangeError?: string } = {}) {
  let saved: string | null = null;
  const writes: string[] = [];
  const requests: URLSearchParams[] = [];
  let nonce = '';
  let clock = now;
  const authorizations: URL[] = [];
  const modelHeaders: Headers[] = [];
  const pages: Promise<string>[] = [];
  const changes: ChatGptAccountStatus[] = [];
  let refreshResponse = () => Promise.resolve(Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, scope }));
  const vault = {
    read: () => saved,
    save: (_id: string, value: string) => { saved = value; writes.push(value); return { available: true as const, exists: true }; },
    remove: () => { saved = null; return { available: true as const, exists: false }; },
  };
  const auth = new ChatGptAuth({
    vault, now: () => clock, getHostId: () => 'urn:uuid:installation', setHostId: () => {},
    openBrowser: async url => {
      const authorize = new URL(url);
      authorizations.push(authorize);
      await options.beforeCallback?.();
      nonce = authorize.searchParams.get('nonce') ?? '';
      const callback = new URL(authorize.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({ code: 'code', client_id: 'issued-client', state: authorize.searchParams.get('state')!, ...options.callback }).toString();
      // Like a real browser tab: the page arrives whenever the app finishes, not before openBrowser returns.
      // A cancelled attempt has already closed the listener; that tab simply gets no page.
      pages.push(new Promise<string>(resolve => {
        get(callback, response => {
          let body = '';
          response.setEncoding('utf8').on('data', (chunk: string) => { body += chunk; }).on('end', () => resolve(body));
        }).on('error', () => resolve(''));
      }));
    },
    onChanged: status => changes.push(status),
    fetch: async (input, init) => {
      if (input.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks' });
      if (input.endsWith('/jwks')) return Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' }] });
      if (input.endsWith('/oauth/token')) {
        const form = new URLSearchParams(String(init?.body));
        requests.push(form);
        if (form.get('grant_type') === 'refresh_token') return refreshResponse();
        if (options.exchangeError) return Response.json({ error: options.exchangeError }, { status: 400 });
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'issued-client', sub: 'account-1', email: 'user@example.com', exp: now / 1000 + 3600, nonce, ...options.claims })).toString('base64url');
        const data = `${header}.${payload}`;
        const id_token = `${data}.${sign('RSA-SHA256', Buffer.from(options.badSignature ? 'different payload' : data), privateKey).toString('base64url')}`;
        return Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: options.scope ?? scope, id_token });
      }
      if (input.endsWith('/oauth/revoke')) return new Response(null, { status: 200 });
      if (input.endsWith('/models')) {
        modelHeaders.push(new Headers(init?.headers));
        return Response.json({ models: [
          { slug: 'gpt-plan', display_name: 'Plan model', visibility: 'list' },
          { slug: 'internal', display_name: 'Hidden model', visibility: 'hidden' },
        ] });
      }
      throw new Error('Unexpected request');
    },
  });
  return { auth, writes, requests, authorizations, modelHeaders, pages, changes, advance: () => { clock += 3400_000; }, setRefresh: (response: typeof refreshResponse) => { refreshResponse = response; } };
}

it('keeps identity sign-in without plan consent but never hands out an inference token', async () => {
  const { auth } = fixture({ scope: 'openid email' });
  expect(await auth.signIn()).toEqual({ state: 'signed-in', email: 'user@example.com', planUsage: false });
  await expect(auth.getAccessToken()).rejects.toThrow('plan usage');
});

it('shares refresh across callers and persists the rotating grant in one write', async () => {
  const { auth, advance, requests, writes } = fixture();
  await auth.signIn();
  advance();
  expect(await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()])).toEqual(['access-2', 'access-2', 'access-2']);
  expect(requests.filter(form => form.get('grant_type') === 'refresh_token')).toHaveLength(1);
  expect(requests[1].get('client_id')).toBe('issued-client');
  expect(writes).toHaveLength(3);
  expect(JSON.parse(writes[2]).tokens).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: now + 7000_000, scopes: scope.split(' ') });
});

it('does not report a routine token refresh as an account change', async () => {
  const { auth, advance, changes } = fixture();
  await auth.signIn();
  advance();
  await auth.getAccessToken();
  expect(changes).toEqual([{ state: 'signed-in', email: 'user@example.com', planUsage: true }]);
});

it('tells the browser the outcome only after the code exchange and identity checks', async () => {
  const signedIn = fixture();
  await signedIn.auth.signIn();
  expect(await signedIn.pages[0]).toContain('You’re signed in');

  const noPlan = fixture({ scope: 'openid email' });
  await noPlan.auth.signIn();
  expect(await noPlan.pages[0]).toContain('Plan usage not allowed');

  const failed = fixture({ exchangeError: 'invalid_grant' });
  await expect(failed.auth.signIn()).rejects.toThrow('ChatGPT');
  const page = await failed.pages[0];
  expect(page).toContain('Sign-in could not be completed');
  expect(page).not.toContain('signed in');
});

for (const code of ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']) {
  it(`requires sign-in after the renewable session is rejected with ${code}`, async () => {
    const { auth, advance, setRefresh, writes } = fixture();
    await auth.signIn();
    advance();
    setRefresh(() => Promise.resolve(Response.json({ error: code, error_description: 'secret-refresh-token' }, { status: 400 })));
    await expect(auth.getAccessToken()).rejects.toThrow('sign in');
    expect(auth.getStatus()).toEqual({ state: 'signed-out' });
    expect(JSON.parse(writes.at(-1)!).tokens).toBeNull();
  });
}

const invalidCallbacks: Record<string, string>[] = [
  { state: 'wrong' }, { error: 'access_denied' }, { client_id: 'dynamic_agent_client' }, { client_id: '' },
];
for (const callback of invalidCallbacks) {
  it(`rejects an invalid or denied callback before exchanging a code: ${JSON.stringify(callback)}`, async () => {
    const { auth, requests } = fixture({ callback });
    await expect(auth.signIn()).rejects.toThrow('ChatGPT');
    expect(requests).toHaveLength(0);
    expect(auth.getStatus()).toEqual({ state: 'signed-out' });
  });
}

for (const claims of [
  { nonce: 'wrong' }, { aud: 'other-client' }, { iss: 'https://attacker.example' }, { exp: now / 1000 },
] as const) {
  it(`rejects a correctly signed ID token with invalid identity claims: ${JSON.stringify(claims)}`, async () => {
    const { auth, writes } = fixture({ claims });
    await expect(auth.signIn()).rejects.toThrow('identity could not be verified');
    expect(writes.every(write => JSON.parse(write).tokens === undefined)).toBe(true);
  });
}

it('signs out locally and reuses the verified registration for the next sign-in', async () => {
  const { auth, writes, authorizations, requests } = fixture();
  await auth.signIn();
  expect(await auth.signOut()).toEqual({ state: 'signed-out' });
  expect(JSON.parse(writes.at(-1)!).tokens).toBeNull();
  await expect(auth.getAccessToken()).rejects.toThrow('Sign in');
  await auth.signIn();
  expect(authorizations[1].searchParams.get('client_id')).toBe('issued-client');
  expect(authorizations[1].searchParams.has('agent_name_hint')).toBe(false);
  expect(requests[1].get('client_id')).toBe('issued-client');
});

it('discovers only listed plan models using a fresh token and refuses discovery while signed out', async () => {
  const { auth, advance, modelHeaders } = fixture();
  await expect(auth.listModels()).rejects.toThrow('Sign in');
  expect(modelHeaders).toHaveLength(0);
  await auth.signIn();
  advance();
  expect(await auth.listModels()).toEqual([{ slug: 'gpt-plan', displayName: 'Plan model' }]);
  expect(modelHeaders[0].get('authorization')).toBe('Bearer access-2');
});

it('rejects an invalid ID-token signature without saving credentials', async () => {
  const { auth, writes } = fixture({ badSignature: true });
  await expect(auth.signIn()).rejects.toThrow('identity could not be verified');
  expect(writes.every(write => JSON.parse(write).tokens === undefined)).toBe(true);
});

it('prevents a late refresh from restoring credentials after sign-out', async () => {
  const { auth, advance, setRefresh, writes } = fixture();
  await auth.signIn();
  advance();
  let complete!: (response: Response) => void;
  setRefresh(() => new Promise(resolve => { complete = resolve; }));
  const pending = auth.getAccessToken();
  await auth.signOut();
  complete(Response.json({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600, scope }));
  await expect(pending).rejects.toThrow('sign in');
  expect(auth.getStatus()).toEqual({ state: 'signed-out' });
  expect(JSON.parse(writes.at(-1)!).tokens).toBeNull();
});

it('rejects duplicate sign-ins and closes the listener when sign-out cancels an attempt', async () => {
  let release!: () => void;
  let opened!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const didOpen = new Promise<void>(resolve => { opened = resolve; });
  const { auth, requests, authorizations } = fixture({ beforeCallback: async () => { opened(); await gate; } });
  const pending = auth.signIn();
  await didOpen;
  await expect(auth.signIn()).rejects.toThrow('already in progress');
  await auth.signOut();
  release();
  await expect(pending).rejects.toThrow('cancelled');
  expect(requests).toHaveLength(0);
  const callback = authorizations[0].searchParams.get('redirect_uri')!;
  await expect(new Promise((resolve, reject) => { get(callback, resolve).on('error', reject); })).rejects.toThrow();
});

it('retains the issued client after code exchange fails so retry does not register a new client', async () => {
  const options: { exchangeError?: string } = { exchangeError: 'invalid_grant' };
  const { auth, authorizations, writes } = fixture(options);
  await expect(auth.signIn()).rejects.toThrow('ChatGPT');
  expect(auth.getStatus()).toEqual({ state: 'signed-out' });
  expect(JSON.parse(writes.at(-1)!).clientId).toBe('issued-client');
  options.exchangeError = undefined;
  await auth.signIn();
  expect(authorizations[1].searchParams.get('client_id')).toBe('issued-client');
});
