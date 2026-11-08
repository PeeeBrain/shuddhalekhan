import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { z } from 'zod';
import type { ChatGptAccountStatus, ChatGptModel } from '../types/ipc';
import type { CredentialVault } from './credential-vault';

const AUTH = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const VAULT_ID = 'chatgpt-account';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const expiredGrantCodes = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired',
  'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
class AuthError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
const tokenSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1),
  expires_in: z.number().positive().finite(), scope: z.string(), id_token: z.string().optional(),
});
const registrationSchema = z.object({ clientId: z.string().min(1).refine(id => id !== 'dynamic_agent_client') });
const accountSchema = registrationSchema.extend({
  issuer: z.string(), subject: z.string(), email: z.string(),
  tokens: z.object({ accessToken: z.string(), refreshToken: z.string(), idToken: z.string(),
    expiresAt: z.number(), scopes: z.array(z.string()) }).nullable(),
});
type Account = z.infer<typeof accountSchema>;
type AuthDeps = {
  vault: Pick<CredentialVault, 'read' | 'save' | 'remove'>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  openBrowser: (url: string) => Promise<void>;
  getHostId: () => string | undefined;
  setHostId: (id: string) => void;
  onChanged?: (status: ChatGptAccountStatus) => void;
  appIconDataUrl?: () => string;
};

// Browser page for the loopback callback. Static strings only; nothing from the query is echoed.
function callbackPage(title: string, body: string, iconDataUrl?: string): string {
  const icon = iconDataUrl?.startsWith('data:image/') ? `<img src="${iconDataUrl}" alt="" width="64" height="64">` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${title} · Shuddhalekhan</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f5f5f4;color:#1c1917}
main{max-width:22rem;padding:2rem;text-align:center}img{border-radius:14px}
h1{margin:1.25rem 0 .5rem;font-size:1.5rem;line-height:1.2;letter-spacing:-.01em;font-weight:600}p{margin:0;color:#57534e}
@media (prefers-color-scheme:dark){body{background:#0c0a09;color:#fafaf9}p{color:#a8a29e}}
</style></head><body><main>${icon}<h1>${title}</h1><p>${body}</p></main></body></html>`;
}

export class ChatGptAuth {
  private account: Account | null = null;
  private clientId: string | undefined;
  private pending: AbortController | null = null;
  private revision = 0;
  private refresh: Promise<void> | null = null;

  constructor(private readonly deps: AuthDeps) {
    try {
      const saved = deps.vault.read(VAULT_ID);
      if (saved) {
        const registration = z.union([accountSchema, registrationSchema]).parse(JSON.parse(saved));
        this.clientId = registration.clientId;
        if ('tokens' in registration) this.account = registration;
      }
    } catch { deps.vault.remove(VAULT_ID); }
  }

  getStatus(): ChatGptAccountStatus {
    return this.account?.tokens
      ? { state: 'signed-in', email: this.account.email, planUsage: this.account.tokens.scopes.includes(PLAN_SCOPE) }
      : { state: 'signed-out' };
  }

  async getAccessToken(): Promise<string> {
    if (!this.account?.tokens) throw new Error('Sign in with ChatGPT in Settings.');
    if (!this.account.tokens.scopes.includes(PLAN_SCOPE)) throw new Error('ChatGPT plan usage is not enabled. Sign in again and allow plan usage.');
    if (this.account.tokens.expiresAt - this.deps.now() < 5 * 60_000) {
      this.refresh ??= this.refreshTokens().finally(() => { this.refresh = null; });
      await this.refresh;
      if (!this.account?.tokens?.scopes.includes(PLAN_SCOPE)) throw new Error('ChatGPT plan usage is not enabled. Sign in again and allow plan usage.');
    }
    return this.account.tokens.accessToken;
  }

  async signOut(): Promise<ChatGptAccountStatus> {
    this.pending?.abort();
    const account = this.account;
    this.revision++;
    this.account = account ? { ...account, tokens: null } : null;
    try {
      const registration = this.account ?? (this.clientId ? { clientId: this.clientId } : null);
      if (registration) this.deps.vault.save(VAULT_ID, JSON.stringify(registration));
      else this.deps.vault.remove(VAULT_ID);
    } catch {
      try { this.deps.vault.remove(VAULT_ID); } catch { /* Local session is already invalidated. */ }
    }
    this.deps.onChanged?.({ state: 'signed-out' });
    if (account?.tokens) {
      try {
        await this.deps.fetch(`${AUTH}/api/accounts/oauth/revoke`, {
          method: 'POST', body: new URLSearchParams({ token: account.tokens.refreshToken,
            token_type_hint: 'refresh_token', client_id: account.clientId }),
          redirect: 'error', signal: AbortSignal.timeout(10_000),
        });
      } catch { /* Best effort; local credentials have already been cleared. */ }
    }
    return { state: 'signed-out' };
  }

  async listModels(): Promise<ChatGptModel[]> {
    const token = await this.getAccessToken();
    try {
      const result = z.object({ models: z.array(z.object({ slug: z.string().min(1), display_name: z.string(), visibility: z.string() })) })
        .parse(await this.requestJson(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } }));
      return result.models.filter(model => model.visibility === 'list').map(model => ({ slug: model.slug, displayName: model.display_name }));
    } catch { throw new Error('ChatGPT models could not be loaded. Please try again or sign in again.'); }
  }

  private async refreshTokens(): Promise<void> {
    const account = this.account;
    if (!account?.tokens) throw new Error('Sign in with ChatGPT in Settings.');
    const revision = this.revision;
    try {
      const data = tokenSchema.parse(await this.requestJson(`${AUTH}/api/accounts/oauth/token`, {
        method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: account.clientId,
          refresh_token: account.tokens.refreshToken, resource: RESOURCE }),
      }));
      if (revision !== this.revision) throw new Error();
      this.save({ ...account, tokens: { accessToken: data.access_token, refreshToken: data.refresh_token,
        // The original verified ID token is a hint only; refresh never changes identity.
        idToken: account.tokens.idToken, expiresAt: this.deps.now() + data.expires_in * 1000,
        scopes: data.scope.split(/\s+/).filter(Boolean) } });
    } catch (error) {
      if (error instanceof AuthError && expiredGrantCodes.has(error.code ?? '') && revision === this.revision) {
        this.save({ ...account, tokens: null });
      }
      if (error instanceof AuthError && error.code === 'invalid_client') throw error;
      // oxlint-disable-next-line preserve-caught-error -- the cause may carry token-response text; Electron logs IPC rejections with causes.
      throw new Error('ChatGPT session could not be refreshed. Please try again or sign in again.');
    }
  }

  async signIn(): Promise<ChatGptAccountStatus> {
    if (this.pending) throw new Error('A ChatGPT sign-in is already in progress.');
    const controller = new AbortController();
    this.pending = controller;
    const timer = setTimeout(() => controller.abort(), 5 * 60_000);
    const revision = this.revision;
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const previous = this.account;
    const server = createServer();
    // The browser tab waits on the valid callback until the code exchange and identity checks finish.
    let finishPage: ((status: ChatGptAccountStatus | undefined) => void) | undefined;
    let result: ChatGptAccountStatus | undefined;
    try {
      let hostId = this.deps.getHostId();
      if (!hostId) {
        hostId = `urn:uuid:${randomUUID()}`;
        this.deps.setHostId(hostId);
      }
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new AuthError('ChatGPT callback listener failed.');
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      const callback = new Promise<URLSearchParams>((resolve, reject) => {
        const abort = () => reject(new AuthError('ChatGPT sign-in was cancelled or timed out. Please try again.'));
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) { abort(); return; }
        server.on('request', (request, response) => {
          let url: URL;
          try { url = new URL(request.url ?? '/', redirectUri); } catch { response.writeHead(400).end(); return; }
          if (request.method !== 'GET' || url.origin !== new URL(redirectUri).origin || url.pathname !== '/auth/callback') {
            response.writeHead(404).end();
            return;
          }
          controller.signal.removeEventListener('abort', abort);
          const query = url.searchParams;
          const page = (status: number, title: string, body: string) => response.writeHead(status, {
            'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close',
            'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
          }).end(callbackPage(title, body, this.deps.appIconDataUrl?.()));
          if (['state', 'code', 'client_id', 'error'].some(key => query.getAll(key).length > 1) || query.get('state') !== state) {
            page(400, 'Sign-in could not be verified', 'Return to Shuddhalekhan and try again.');
            reject(new AuthError('ChatGPT sign-in state did not match. Please try again.'));
          } else if (query.has('error')) {
            page(400, 'Sign-in was not completed', 'Return to Shuddhalekhan and try again when you are ready.');
            reject(new AuthError(query.get('error') === 'access_denied' ? 'ChatGPT sign-in was denied. Please try again when ready.' : 'ChatGPT sign-in failed. Please try again.'));
          } else {
            finishPage = (status) => {
              if (status?.state !== 'signed-in') return page(400, 'Sign-in could not be completed', 'Return to Shuddhalekhan and try again.');
              if (!status.planUsage) return page(200, 'Plan usage not allowed', 'You signed in, but Shuddhalekhan cannot use your ChatGPT plan. Return to the app and continue with ChatGPT again to allow it.');
              return page(200, 'You’re signed in', 'Shuddhalekhan is connected to your ChatGPT plan. You can close this tab and return to the app.');
            };
            resolve(query);
          }
        });
      });
      // Observe early callback failures while the browser-open promise settles.
      void callback.catch(() => undefined);
      const authorize = new URL(`${AUTH}/api/accounts/authorize`);
      authorize.search = new URLSearchParams({
        client_id: this.clientId ?? 'dynamic_agent_client', ext_agent_host_id: hostId,
        ...(!this.clientId ? { agent_name_hint: 'Shuddhalekhan' } : {}),
        ...(previous ? { login_hint: previous.email } : {}),
        ...(previous?.tokens?.idToken ? { id_token_hint: previous.tokens.idToken } : {}),
        response_type: 'code', redirect_uri: redirectUri,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        resource: RESOURCE, state, nonce, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      }).toString();
      const [, query] = await Promise.all([this.deps.openBrowser(authorize.toString()), callback]);
      const clientId = query.get('client_id') ?? this.clientId;
      const code = query.get('code');
      if (!code || !clientId || clientId === 'dynamic_agent_client' || (this.clientId && clientId !== this.clientId)) {
        throw new AuthError('ChatGPT registration was incomplete or changed. Please try again.');
      }
      controller.signal.throwIfAborted();
      if (!this.clientId) {
        // Registration survives an expired code; identity and tokens remain untrusted until verified.
        this.deps.vault.save(VAULT_ID, JSON.stringify({ clientId }));
        this.clientId = clientId;
      }
      const data = tokenSchema.parse(await this.requestJson(`${AUTH}/api/accounts/oauth/token`, {
        method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
          code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }), signal: controller.signal,
      }));
      if (!data.id_token) throw new AuthError('ChatGPT did not return a verifiable identity.');
      const identity = await this.verifyIdentity(data.id_token, clientId, nonce);
      if (previous && (previous.subject !== identity.sub || previous.issuer !== identity.iss)) {
        throw new AuthError('The ChatGPT account does not match this saved registration. Sign in with the original account.');
      }
      if (revision !== this.revision || controller.signal.aborted) throw new AuthError('ChatGPT sign-in was cancelled.');
      this.save({ clientId, issuer: identity.iss, subject: identity.sub, email: identity.email,
        tokens: { accessToken: data.access_token, refreshToken: data.refresh_token, idToken: data.id_token,
          expiresAt: this.deps.now() + data.expires_in * 1000, scopes: data.scope.split(/\s+/).filter(Boolean) } });
      result = this.getStatus();
      return result;
    } catch (error) {
      // Never expose token responses, browser URLs, codes, or crypto parser errors.
      if (error instanceof AuthError) throw error;
      // oxlint-disable-next-line preserve-caught-error -- the cause may carry tokens or codes; Electron logs IPC rejections with causes.
      throw new Error('ChatGPT sign-in could not be completed. Please try again.');
    } finally {
      clearTimeout(timer);
      controller.abort();
      // The final page sends `Connection: close`, so its socket ends itself once flushed.
      // Destroying it here would truncate the page.
      finishPage?.(result);
      server.close();
      if (!finishPage) server.closeAllConnections();
      if (this.pending === controller) this.pending = null;
    }
  }

  private save(account: Account): void {
    const before = JSON.stringify(this.getStatus());
    this.deps.vault.save(VAULT_ID, JSON.stringify(account));
    this.account = account;
    this.clientId = account.clientId;
    this.revision++;
    // Routine token rotation keeps the same status; only account changes invalidate tests and runs.
    const status = this.getStatus();
    if (JSON.stringify(status) !== before) this.deps.onChanged?.(status);
  }

  private async requestJson(url: string, init?: RequestInit): Promise<unknown> {
    const response = await this.deps.fetch(url, {
      ...init, redirect: 'error', signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const parsed = z.object({ error: z.string().optional() }).safeParse(await response.json().catch(() => null));
      const code = parsed.success ? parsed.data.error : undefined;
      throw new AuthError(code === 'invalid_client'
        ? 'ChatGPT registration is invalid. Check the app configuration and sign in again.'
        : 'ChatGPT could not complete the request. Please try again.', code);
    }
    return response.json();
  }

  private async verifyIdentity(token: string, clientId: string, nonce: string) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error();
      const [header, payload, signature] = parts;
      const jwtHeader = z.object({ alg: z.literal('RS256'), kid: z.string() }).parse(JSON.parse(Buffer.from(header, 'base64url').toString()));
      const discovery = z.object({ issuer: z.literal(AUTH), jwks_uri: z.string().url() })
        .parse(await this.requestJson(`${AUTH}/.well-known/openid-configuration`));
      if (new URL(discovery.jwks_uri).origin !== AUTH) throw new Error();
      const jwks = z.object({ keys: z.array(z.unknown()) }).parse(await this.requestJson(discovery.jwks_uri));
      const keySchema = z.object({ kty: z.literal('RSA'), kid: z.literal(jwtHeader.kid), n: z.string(), e: z.string(),
        alg: z.literal('RS256').optional(), use: z.literal('sig').optional() });
      const jwk = jwks.keys.map(key => keySchema.safeParse(key)).find(key => key.success)?.data;
      if (!jwk || !verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))) throw new Error();
      const identity = z.object({ iss: z.literal(discovery.issuer), sub: z.string().min(1), email: z.string().email(),
        aud: z.union([z.string(), z.array(z.string())]), exp: z.number(), nonce: z.literal(nonce), azp: z.string().optional() })
        .parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
      const audiences = typeof identity.aud === 'string' ? [identity.aud] : identity.aud;
      if (!audiences.includes(clientId) || (audiences.length > 1 && identity.azp !== clientId)
        || (identity.azp !== undefined && identity.azp !== clientId) || identity.exp * 1000 <= this.deps.now()) throw new Error();
      return identity;
    } catch { throw new AuthError('ChatGPT identity could not be verified. Please sign in again.'); }
  }
}
