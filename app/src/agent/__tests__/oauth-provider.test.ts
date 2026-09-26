import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SidecarOAuthProvider } from '../oauth-provider';
import type { McpServerConfig } from '../../types/ipc';

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

    const tokenFilePath = join(appDataDir, 'Shuddhalekhan', 'agent', 'oauth', 'static-client-server.json');
    expect(() => readFileSync(tokenFilePath, 'utf-8')).toThrow();
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

  it('enforces the server redirect policy during provider-owned OAuth requests', async () => {
    const baseFetch = mock(async () => new Response(null, { status: 204 }));
    const authFn = mock(async (_provider: unknown, options: { fetchFn?: typeof globalThis.fetch }) => {
      await options.fetchFn?.('https://auth.example.test/.well-known/oauth-authorization-server', {
        redirect: 'follow',
      });
      return 'AUTHORIZED' as const;
    });
    const provider = new SidecarOAuthProvider({
      id: 'secure-http',
      displayName: 'Secure HTTP',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://mcp.example.test/mcp',
        redirect: 'error',
      },
      discoveredTools: [],
      toolPolicies: {},
    }, baseFetch as never, authFn as never);

    await provider.ensureAuthenticated();

    expect(authFn).toHaveBeenCalledTimes(1);
    expect(baseFetch).toHaveBeenCalledWith(
      'https://auth.example.test/.well-known/oauth-authorization-server',
      { redirect: 'error' },
    );
    provider.close();
  });
});
