import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
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
      transport: { type: 'http', url: 'https://mcp.example.test/mcp' },
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
