import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { auth } from '@ai-sdk/mcp';
import { get } from 'node:http';
import { SidecarOAuthProvider } from '../oauth-provider';
import type { McpServerConfig } from '../../types/ipc';

function requestCallback(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get(url, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    }).once('error', reject);
  });
}

const originalAppData = process.env.APPDATA;
let appDataDir = '';

beforeEach(() => {
  appDataDir = mkdtempSync(join(tmpdir(), 'shuddhalekhan-oauth-'));
  process.env.APPDATA = appDataDir;
});

afterEach(() => {
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  rmSync(appDataDir, { recursive: true, force: true });
});

describe('SidecarOAuthProvider', () => {
  const originalTestSecret = process.env.SHUDDHA_TEST_OAUTH_SECRET;

  afterEach(() => {
    if (originalTestSecret === undefined) delete process.env.SHUDDHA_TEST_OAUTH_SECRET;
    else process.env.SHUDDHA_TEST_OAUTH_SECRET = originalTestSecret;
  });

  function httpServer(transport: Partial<Extract<McpServerConfig['transport'], { type: 'http' }>> = {}): McpServerConfig {
    return {
      id: 'static-client-server',
      displayName: 'Static client server',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://mcp.example.test/mcp',
        redirect: 'error',
        ...transport,
      },
      discoveredTools: [],
      toolPolicies: {},
    };
  }

  it('serves a pre-registered client from server config without dynamic registration', () => {
    process.env.SHUDDHA_TEST_OAUTH_SECRET = 'secret-1';
    const provider = new SidecarOAuthProvider(httpServer({
      oauth: {
        clientId: 'static-client',
        clientSecretEnvVar: 'SHUDDHA_TEST_OAUTH_SECRET',
        scopes: ['scope-a', 'scope-b'],
      },
    }));

    expect(provider.clientInformation()).toEqual({
      client_id: 'static-client',
      client_secret: 'secret-1',
    });
  });

  it('serves a public pre-registered client when the secret environment variable is absent', () => {
    const provider = new SidecarOAuthProvider(httpServer({
      oauth: {
        clientId: 'static-client',
        clientSecretEnvVar: 'SHUDDHA_TEST_OAUTH_SECRET',
        scopes: [],
      },
    }));

    expect(provider.clientInformation()).toEqual({ client_id: 'static-client' });
  });

  it('completes a pre-registered client callback without storing the client secret', async () => {
    process.env.SHUDDHA_TEST_OAUTH_SECRET = 'secret-1';
    const serverUrl = 'https://auth.example.test/';
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://auth.example.test/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer: 'https://auth.example.test',
          authorization_endpoint: 'https://auth.example.test/authorize',
          token_endpoint: 'https://auth.example.test/token',
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url === 'https://auth.example.test/token') {
        return Response.json({ access_token: 'new-token', token_type: 'Bearer' });
      }
      return new Response(null, { status: 404 });
    };
    class CallbackProvider extends SidecarOAuthProvider {
      override async redirectToAuthorization(url: URL): Promise<void> {
        await auth(this, {
          serverUrl,
          authorizationCode: 'authorization-code',
          callbackState: url.searchParams.get('state') ?? undefined,
          fetchFn,
        });
      }
    }
    const provider = new CallbackProvider(httpServer({
      url: serverUrl,
      oauth: { clientId: 'static-client', clientSecretEnvVar: 'SHUDDHA_TEST_OAUTH_SECRET', scopes: [] },
    }), fetchFn);

    await provider.start();
    try {
      await auth(provider, { serverUrl, fetchFn });
      expect(provider.tokens()?.access_token).toBe('new-token');
      const tokenDir = join(appDataDir, 'Shuddhalekhan', 'agent', 'oauth');
      const [tokenFile] = readdirSync(tokenDir);
      expect(tokenFile).toBeDefined();
      const stored = readFileSync(join(tokenDir, tokenFile), 'utf-8');
      expect(stored).not.toContain('secret-1');
    } finally {
      provider.close();
    }
  });

  it('settles authorization when closed and permits a new listener without old cleanup closing it', async () => {
    const codes: Array<string | undefined> = [];
    const authenticate: typeof auth = async (_provider, options) => {
      codes.push(options.authorizationCode);
      return 'AUTHORIZED';
    };
    const provider = new SidecarOAuthProvider(httpServer(), fetch, authenticate);
    await provider.start();
    const cancelled = provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'));
    // redirectToAuthorization installs its waiter after its already-resolved startup promise.
    await Promise.resolve();
    provider.close();
    await expect(cancelled).rejects.toThrow('cancelled');
    await provider.start();
    const currentUrl = provider.redirectUrl;
    try {
      const current = provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'));
      const status = await requestCallback(`${currentUrl}?code=current`);
      expect(status).toBe(200);
      await current;
      expect(codes).toEqual(['current']);
    } finally { provider.close(); }
  });

  it('cancels listener startup before a late listening callback can replace a new listener', async () => {
    const provider = new SidecarOAuthProvider(httpServer());
    const starting = provider.start();
    provider.close();
    await expect(starting).rejects.toThrow('cancelled');
    await provider.start();
    try {
      expect(new URL(provider.redirectUrl).hostname).toBe('127.0.0.1');
      const pending = provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'));
      await Promise.resolve();
      provider.close();
      await expect(pending).rejects.toThrow('cancelled');
    } finally { provider.close(); }
  });

  it('does not reopen a closed listener for a late authorization request', async () => {
    const provider = new SidecarOAuthProvider(httpServer());
    await provider.start();
    provider.close();
    await expect(provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'))).rejects.toThrow('cancelled');
  });

  it('does not let an authorization resumed after close take a replacement listener', async () => {
    const provider = new SidecarOAuthProvider(httpServer());
    await provider.start();
    const previous = provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'));
    provider.close();
    const replacement = provider.start();
    await expect(previous).rejects.toThrow('cancelled');
    await replacement;
    try {
      const pending = provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'));
      await Promise.resolve();
      provider.close();
      await expect(pending).rejects.toThrow('cancelled');
    } finally { provider.close(); }
  });

  it('keeps authorization pending after a code-less callback so a later valid callback can complete', async () => {
    const exchanged: Array<{ code: string | undefined; state: string | undefined }> = [];
    const authenticate: typeof auth = async (_provider, options) => {
      exchanged.push({ code: options.authorizationCode, state: options.callbackState });
      return 'AUTHORIZED';
    };
    const provider = new SidecarOAuthProvider(httpServer(), fetch, authenticate);
    await provider.start();
    const callbackUrl = provider.redirectUrl;
    const pending = provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'));
    try {
      const invalid = await requestCallback(`${callbackUrl}?state=state-1`);
      expect(invalid).toBe(400);
      expect(exchanged).toEqual([]);
      const valid = await requestCallback(`${callbackUrl}?code=code-1&state=state-1`);
      expect(valid).toBe(200);
      await pending;
      expect(exchanged).toEqual([{ code: 'code-1', state: 'state-1' }]);
    } finally { provider.close(); }
  });

  it('does not reuse tokens after the pre-registered client or scopes change', () => {
    const oauth = { clientId: 'client-a', clientSecretEnvVar: '', scopes: ['read'] };
    new SidecarOAuthProvider(httpServer({ oauth })).saveTokens({ access_token: 'old-token', token_type: 'Bearer' });

    const changedClient = new SidecarOAuthProvider(httpServer({ oauth: { ...oauth, clientId: 'client-b' } }));
    expect(changedClient.tokens()).toBeUndefined();
    expect(new SidecarOAuthProvider(httpServer({ oauth: { ...oauth, scopes: ['write'] } })).tokens()).toBeUndefined();
    changedClient.saveTokens({ access_token: 'new-token', token_type: 'Bearer' });
    expect(new SidecarOAuthProvider(httpServer({ oauth })).tokens()?.access_token).toBe('old-token');
  });

  it('keeps the pre-registered client when the token store is invalidated', () => {
    process.env.SHUDDHA_TEST_OAUTH_SECRET = 'secret-1';
    const provider = new SidecarOAuthProvider(httpServer({
      oauth: {
        clientId: 'static-client',
        clientSecretEnvVar: 'SHUDDHA_TEST_OAUTH_SECRET',
        scopes: [],
      },
    }));

    provider.invalidateCredentials('all');

    expect(provider.clientInformation()).toEqual({
      client_id: 'static-client',
      client_secret: 'secret-1',
    });
  });

  it('sends the configured scopes in client metadata during authorization', async () => {
    const provider = new SidecarOAuthProvider(httpServer({
      oauth: {
        clientId: 'static-client',
        clientSecretEnvVar: 'SHUDDHA_TEST_OAUTH_SECRET',
        scopes: ['scope-a', 'scope-b'],
      },
    }));

    await provider.start();
    try {
      expect(provider.clientMetadata.scope).toBe('scope-a scope-b');
    } finally {
      provider.close();
    }
  });

  it('omits scope from client metadata when no OAuth scopes are configured', async () => {
    const provider = new SidecarOAuthProvider(httpServer());

    await provider.start();
    try {
      expect(provider.clientMetadata.scope).toBeUndefined();
    } finally {
      provider.close();
    }
  });

  it('preserves the authorization-server metadata pin with stored credentials', () => {
    const provider = new SidecarOAuthProvider({
      id: 'secure-http',
      displayName: 'Secure HTTP',
      enabled: true,
      transport: { type: 'http', url: 'https://mcp.example.test/mcp', redirect: 'error' },
      discoveredTools: [],
      toolPolicies: {},
    });
    const authorizationServerPin = {
      authorization_server: 'https://auth.example.test/',
      token_endpoint: 'https://auth.example.test/oauth/token',
    };

    provider.saveClientInformation({
      client_id: 'client-1',
      ...authorizationServerPin,
    });
    provider.saveTokens({
      access_token: 'token-1',
      token_type: 'Bearer',
      ...authorizationServerPin,
    });

    expect(provider.clientInformation()).toEqual({
      client_id: 'client-1',
      ...authorizationServerPin,
    });
    expect(provider.tokens()).toEqual({
      access_token: 'token-1',
      token_type: 'Bearer',
      ...authorizationServerPin,
    });
  });

});
