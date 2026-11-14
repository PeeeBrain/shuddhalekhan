import { homedir } from 'os';
import { createHash, randomBytes } from 'crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { join } from 'path';
import {
  auth,
  type OAuthAuthorizationServerInformation,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from '@ai-sdk/mcp';
import type { McpHttpOAuthConfig, McpServerConfig } from '../types/ipc';
import { logSidecar, writeJsonLine } from './protocol';

type TokenFile = {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformation;
  authorizationServerInformation?: OAuthAuthorizationServerInformation;
  codeVerifier?: string;
  state?: string;
};

type CallbackResult = { code: string; state?: string };
type CallbackListener =
  | { kind: 'idle' }
  | { kind: 'closed' }
  | { kind: 'starting'; server: Server; promise: Promise<Server>; reject: (error: Error) => void }
  | { kind: 'listening'; server: Server; url: string }
  | { kind: 'waiting'; server: Server; url: string; finish: (result: CallbackResult | Error) => void };

export class SidecarOAuthProvider implements OAuthClientProvider {
  private readonly tokenPath: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly oauthConfig: McpHttpOAuthConfig | undefined;
  private callback: CallbackListener = { kind: 'idle' };
  private lastRedirectUrl: string | null = null;

  constructor(
    private readonly server: McpServerConfig,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
    private readonly authenticate: typeof auth = auth,
  ) {
    if (server.transport.type !== 'http') {
      throw new Error('OAuth provider requires an HTTP MCP server.');
    }

    const clientKey = server.transport.oauth
      ? `-${createHash('sha256').update(JSON.stringify([server.transport.url, server.transport.oauth])).digest('hex')}`
      : '';
    this.tokenPath = join(getAgentDataDir(), 'oauth', `${sanitizeFileName(server.id)}${clientKey}.json`);
    this.fetchFn = createRedirectAwareFetch(fetchFn, server.transport.redirect);
    this.oauthConfig = server.transport.oauth;
  }

  get redirectUrl(): string {
    const redirectUrl = this.callback.kind === 'listening' || this.callback.kind === 'waiting'
      ? this.callback.url : this.lastRedirectUrl;
    if (!redirectUrl) {
      throw new Error('OAuth callback server has not started.');
    }
    return redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const scopes = this.oauthConfig?.scopes ?? [];
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Shuddhalekhan',
      ...(scopes.length > 0 ? { scope: scopes.join(' ') } : {}),
    };
  }

  async start(): Promise<void> {
    if (this.callback.kind === 'closed') this.callback = { kind: 'idle' };
    await this.startCallbackServer();
  }

  tokens(): OAuthTokens | undefined {
    return this.readTokenFile().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const current = this.readTokenFile();
    this.writeTokenFile({ ...current, tokens });
  }

  clientInformation(): OAuthClientInformation | undefined {
    const staticClient = staticClientInformation(this.oauthConfig);
    if (staticClient) return staticClient;
    return this.readTokenFile().clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformation): void {
    const current = this.readTokenFile();
    const storedClient = { ...clientInformation };
    if (this.oauthConfig) delete storedClient.client_secret;
    this.writeTokenFile({ ...current, clientInformation: storedClient });
  }

  authorizationServerInformation(): OAuthAuthorizationServerInformation | undefined {
    return this.readTokenFile().authorizationServerInformation;
  }

  saveAuthorizationServerInformation(information: OAuthAuthorizationServerInformation): void {
    const current = this.readTokenFile();
    this.writeTokenFile({ ...current, authorizationServerInformation: information });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const server = await this.startCallbackServer();
    const pending = this.waitForCallback(server);
    writeJsonLine({
      type: 'oauth:open-url',
      serverId: this.server.id,
      url: authorizationUrl.href,
    });

    const callback = await pending;
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
    const callback = this.callback;
    if (callback.kind === 'closed' || callback.kind === 'idle') { this.callback = { kind: 'closed' }; return; }
    const error = new Error('OAuth authorization was cancelled.');
    if (callback.kind === 'waiting') {
      callback.finish(error);
      this.callback = { kind: 'closed' };
      return;
    }
    this.callback = { kind: 'closed' };
    callback.server.close();
    if (callback.kind === 'starting') callback.reject(error);
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

  private startCallbackServer(): Promise<Server> {
    const callback = this.callback;
    if (callback.kind === 'starting') return callback.promise;
    if (callback.kind === 'closed') return Promise.reject(new Error('OAuth authorization was cancelled.'));
    if (callback.kind === 'listening' || callback.kind === 'waiting') return Promise.resolve(callback.server);

    const server = createServer();
    let resolveStarted: (server: Server) => void = () => undefined;
    let rejectStarted: (error: Error) => void = () => undefined;
    const promise = new Promise<Server>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    const starting = { kind: 'starting', server, promise, reject: rejectStarted } satisfies CallbackListener;
    this.callback = starting;
    server.on('error', error => {
      if (this.callback.kind === 'waiting' && this.callback.server === server) {
        this.callback.finish(error);
      } else if (this.callback === starting) {
        this.callback = { kind: 'closed' };
        server.close();
        rejectStarted(error);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      if (this.callback !== starting) { server.close(); return; }
      const address = server.address();
      if (!address || typeof address === 'string') {
        this.close();
        return;
      }
      const url = `http://127.0.0.1:${address.port}/oauth/callback`;
      this.callback = { kind: 'listening', server, url };
      this.lastRedirectUrl = url;
      resolveStarted(server);
    });
    return promise;
  }

  private waitForCallback(expectedServer: Server): Promise<CallbackResult> {
    const callback = this.callback;
    if (callback.kind !== 'listening' || callback.server !== expectedServer) {
      return Promise.reject(new Error('OAuth authorization was cancelled or is already waiting.'));
    }
    const { server, url: callbackUrl } = callback;
    return new Promise((resolve, reject) => {
      const waiting = { kind: 'waiting', server, url: callbackUrl, finish: (result: CallbackResult | Error) => {
        if (this.callback !== waiting) return;
        this.callback = { kind: 'idle' };
        clearTimeout(timeout);
        server.removeAllListeners('request');
        server.close();
        if (result instanceof Error) reject(result);
        else resolve(result);
      } } satisfies CallbackListener;
      const timeout = setTimeout(() => waiting.finish(new Error('OAuth authorization timed out.')), 120_000);
      this.callback = waiting;
      server.on('request', (request, response) => {
        response.setHeader('Connection', 'close');
        try {
          const url = new URL(request.url ?? '/', callbackUrl);
          if (url.pathname !== '/oauth/callback') {
            response.writeHead(404).end();
            return;
          }
          const error = url.searchParams.get('error');
          if (error) {
            response.writeHead(400, { 'Content-Type': 'text/plain' }).end('Authorization failed. You can close this window.');
            waiting.finish(new Error(`OAuth authorization failed: ${error}`));
            return;
          }
          const code = url.searchParams.get('code');
          if (!code) {
            response.writeHead(400, { 'Content-Type': 'text/plain' }).end('Missing authorization code.');
            return;
          }
          response.writeHead(200, { 'Content-Type': 'text/plain' }).end('MCP server connected. You can close this window.');
          waiting.finish({ code, state: url.searchParams.get('state') ?? undefined });
        } catch (error) {
          logSidecar('OAuth callback failed', error);
          waiting.finish(error instanceof Error ? error : new Error('OAuth callback failed.'));
        }
      });
    });
  }

}

// Pre-registered clients (configured client ID/secret) skip dynamic client
// registration entirely; the secret is read from the environment at call time
// and never persisted.
function staticClientInformation(
  oauth: McpHttpOAuthConfig | undefined,
): OAuthClientInformation | undefined {
  if (!oauth?.clientId) return undefined;
  const clientSecret = oauth.clientSecretEnvVar ? process.env[oauth.clientSecretEnvVar] : undefined;
  return {
    client_id: oauth.clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  };
}

export function createRedirectAwareFetch(
  fetchFn: typeof globalThis.fetch,
  redirect: 'error' | 'follow',
): typeof globalThis.fetch {
  return (input, init) => fetchFn(input, { ...init, redirect });
}

function getAgentDataDir(): string {
  const base = process.env.APPDATA ?? process.env.LOCALAPPDATA ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'Shuddhalekhan', 'agent');
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
