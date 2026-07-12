import { randomBytes } from 'crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { join } from 'path';
import {
  auth,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from '@ai-sdk/mcp';
import type { McpServerConfig } from '../types/ipc';
import { logSidecar, writeJsonLine } from './protocol';

type TokenFile = {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformation;
  codeVerifier?: string;
  state?: string;
};

export class SidecarOAuthProvider implements OAuthClientProvider {
  private readonly tokenPath: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private callbackServer: Server | null = null;
  private callbackUrl: string | null = null;
  private lastRedirectUrl: string | null = null;

  constructor(
    private readonly server: McpServerConfig,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
    private readonly authenticate: typeof auth = auth,
  ) {
    if (server.transport.type !== 'http') {
      throw new Error('OAuth provider requires an HTTP MCP server.');
    }

    this.tokenPath = join(getAgentDataDir(), 'oauth', `${sanitizeFileName(server.id)}.json`);
    this.fetchFn = createRedirectAwareFetch(fetchFn, server.transport.redirect);
  }

  get redirectUrl(): string {
    const redirectUrl = this.callbackUrl ?? this.lastRedirectUrl;
    if (!redirectUrl) {
      throw new Error('OAuth callback server has not started.');
    }
    return redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Shuddhalekhan',
    };
  }

  async start(): Promise<void> {
    await this.startCallbackServer();
  }

  async ensureAuthenticated(): Promise<void> {
    if (this.tokens()?.access_token) return;

    await this.startCallbackServer();
    const result = await this.authenticate(this, {
      serverUrl: this.server.transport.type === 'http' ? this.server.transport.url : '',
      fetchFn: this.fetchFn,
    });

    if (result !== 'AUTHORIZED' && !this.tokens()?.access_token) {
      throw new Error('OAuth authorization did not complete.');
    }
  }

  tokens(): OAuthTokens | undefined {
    return this.readTokenFile().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const current = this.readTokenFile();
    this.writeTokenFile({ ...current, tokens });
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.readTokenFile().clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformation): void {
    const current = this.readTokenFile();
    this.writeTokenFile({ ...current, clientInformation });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.startCallbackServer();
    writeJsonLine({
      type: 'oauth:open-url',
      serverId: this.server.id,
      url: authorizationUrl.href,
    });

    const callback = await this.waitForCallback();
    await this.authenticate(this, {
      serverUrl: this.server.transport.type === 'http' ? this.server.transport.url : '',
      authorizationCode: callback.code,
      callbackState: callback.state,
      fetchFn: this.fetchFn,
    });
  }

  saveCodeVerifier(codeVerifier: string): void {
    const current = this.readTokenFile();
    this.writeTokenFile({ ...current, codeVerifier });
  }

  codeVerifier(): string {
    const verifier = this.readTokenFile().codeVerifier;
    if (!verifier) throw new Error('OAuth code verifier is missing.');
    return verifier;
  }

  state(): string {
    return randomBytes(24).toString('base64url');
  }

  saveState(state: string): void {
    const current = this.readTokenFile();
    this.writeTokenFile({ ...current, state });
  }

  storedState(): string | undefined {
    return this.readTokenFile().state;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): void {
    if (scope === 'all') {
      rmSync(this.tokenPath, { force: true });
      return;
    }

    const current = this.readTokenFile();
    if (scope === 'client') delete current.clientInformation;
    if (scope === 'tokens') delete current.tokens;
    if (scope === 'verifier') delete current.codeVerifier;
    this.writeTokenFile(current);
  }

  close(): void {
    this.callbackServer?.close();
    this.callbackServer = null;
    this.callbackUrl = null;
  }

  private readTokenFile(): TokenFile {
    try {
      return JSON.parse(readFileSync(this.tokenPath, 'utf-8')) as TokenFile;
    } catch {
      return {};
    }
  }

  private writeTokenFile(value: TokenFile): void {
    mkdirSync(join(getAgentDataDir(), 'oauth'), { recursive: true });
    writeFileSync(this.tokenPath, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  private async startCallbackServer(): Promise<void> {
    if (this.callbackServer && this.callbackUrl) return;

    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to start OAuth callback server.'));
          return;
        }
        this.callbackServer = server;
        this.callbackUrl = `http://127.0.0.1:${address.port}/oauth/callback`;
        this.lastRedirectUrl = this.callbackUrl;
        resolve();
      });
    });
  }

  private waitForCallback(): Promise<{ code: string; state?: string }> {
    return new Promise((resolve, reject) => {
      if (!this.callbackServer) {
        reject(new Error('OAuth callback server is not running.'));
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('OAuth authorization timed out.'));
      }, 120_000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.callbackServer?.removeAllListeners('request');
        this.close();
      };

      let handledCallback = false;

      this.callbackServer.on('request', (request, response) => {
        try {
          const url = new URL(request.url ?? '/', this.redirectUrl);
          if (url.pathname !== '/oauth/callback') {
            response.writeHead(404).end();
            return;
          }

          if (handledCallback) {
            response.writeHead(409, { 'Content-Type': 'text/plain' }).end('Authorization callback already handled.');
            return;
          }
          handledCallback = true;

          const error = url.searchParams.get('error');
          if (error) {
            response.writeHead(400, { 'Content-Type': 'text/plain' }).end('Authorization failed. You can close this window.');
            cleanup();
            reject(new Error(`OAuth authorization failed: ${error}`));
            return;
          }

          const code = url.searchParams.get('code');
          if (!code) {
            response.writeHead(400, { 'Content-Type': 'text/plain' }).end('Missing authorization code.');
            return;
          }

          response.writeHead(200, { 'Content-Type': 'text/plain' }).end('MCP server connected. You can close this window.');
          const state = url.searchParams.get('state') ?? undefined;
          cleanup();
          resolve({ code, state });
        } catch (err) {
          logSidecar('OAuth callback failed', err);
          cleanup();
          reject(err);
        }
      });
    });
  }
}

export function createRedirectAwareFetch(
  fetchFn: typeof globalThis.fetch,
  redirect: 'error' | 'follow',
): typeof globalThis.fetch {
  return (input, init) => fetchFn(input, { ...init, redirect });
}

function getAgentDataDir(): string {
  const base = process.env.APPDATA ?? process.env.LOCALAPPDATA ?? process.cwd();
  return join(base, 'Shuddhalekhan', 'agent');
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
