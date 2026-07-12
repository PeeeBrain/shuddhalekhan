import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SidecarOAuthProvider } from '../oauth-provider';

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
