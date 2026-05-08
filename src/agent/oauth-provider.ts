import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { createServer, type Server } from 'http';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { auth, type OAuthClientInformation, type OAuthClientMetadata, type OAuthClientProvider, type OAuthTokens } from '@ai-sdk/mcp';
import type { McpServerConfig } from '../types/ipc';
import { logSidecar, writeJsonLine } from './protocol';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

type TokenFile = {
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

export class SidecarOAuthProvider implements OAuthClientProvider {
  private readonly tokenPath: string;
  private readonly clientId: string;
  private readonly clientSecret: string | undefined;
  private callbackServer: Server | null = null;
  private callbackUrl: string | null = null;
  private lastRedirectUrl: string | null = null;

  constructor(private readonly server: McpServerConfig) {
    if (server.transport.type !== 'http' || !server.transport.oauth?.enabled) {
      throw new Error('OAuth provider requires an OAuth-enabled HTTP MCP server.');
    }

    const clientIdEnvVar = server.transport.oauth.clientIdEnvVar ?? 'GOOGLE_CLIENT_ID';
    const clientSecretEnvVar = server.transport.oauth.clientSecretEnvVar ?? 'GOOGLE_CLIENT_SECRET';
    const clientId = process.env[clientIdEnvVar];
    const clientSecret = process.env[clientSecretEnvVar];

    if (!clientId) {
      throw new Error(`Missing OAuth client ID environment variable: ${clientIdEnvVar}`);
    }

    if (server.transport.oauth.credentialSource === 'userProvided' && !clientSecret) {
      throw new Error(`Missing OAuth client secret environment variable: ${clientSecretEnvVar}`);
    }

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokenPath = join(getAgentDataDir(), 'oauth', `${sanitizeFileName(server.id)}.json`);
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
      token_endpoint_auth_method: this.clientSecret ? 'client_secret_post' : 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Shuddhalekhan',
      scope: GMAIL_SCOPES.join(' '),
    };
  }

  async ensureAuthenticated(): Promise<void> {
    if (this.tokens()?.refresh_token) return;

    await this.startCallbackServer();
    const result = await auth(this, {
      serverUrl: this.server.transport.type === 'http' ? this.server.transport.url : '',
      scope: GMAIL_SCOPES.join(' '),
    });

    if (result !== 'AUTHORIZED' && !this.tokens()?.refresh_token) {
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

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.startCallbackServer();
    writeJsonLine({
      type: 'oauth:open-url',
      serverId: this.server.id,
      url: authorizationUrl.href,
    });

    const callback = await this.waitForCallback();
    await auth(this, {
      serverUrl: this.server.transport.type === 'http' ? this.server.transport.url : '',
      authorizationCode: callback.code,
      callbackState: callback.state,
      scope: GMAIL_SCOPES.join(' '),
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

  clientInformation(): OAuthClientInformation {
    return {
      client_id: this.clientId,
      client_secret: this.clientSecret,
    };
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

      this.callbackServer.on('request', (request, response) => {
        try {
          const url = new URL(request.url ?? '/', this.redirectUrl);
          if (url.pathname !== '/oauth/callback') {
            response.writeHead(404).end();
            return;
          }

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

          response.writeHead(200, { 'Content-Type': 'text/plain' }).end('Gmail connected. You can close this window.');
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

function getAgentDataDir(): string {
  const base = process.env.APPDATA ?? process.env.LOCALAPPDATA ?? process.cwd();
  return join(base, 'Shuddhalekhan', 'agent');
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
