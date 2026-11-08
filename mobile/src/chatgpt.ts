import { z } from 'zod';
import type { Fetch } from './network';

const AUTH = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
export const chatGptEndpoint = `${RESOURCE}/responses`;
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const expiredGrants = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired',
  'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const accountSchema = z.object({
  issuer: z.literal(AUTH), subject: z.string().min(1), email: z.email(),
  refreshToken: z.string().min(1), scopes: z.array(z.string()),
});
const savedSchema = z.object({
  hostId: z.string().regex(/^urn:uuid:[0-9a-f-]{36}$/i),
  clientId: z.string().min(1).refine(id => id !== 'dynamic_agent_client').nullable(),
  // Identity survives sign-out so the registration cannot silently switch accounts.
  identity: z.object({ issuer: z.literal(AUTH), subject: z.string().min(1), email: z.email() }).nullable(),
  account: accountSchema.nullable(),
});
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1),
  expires_in: z.number().positive().finite(), scope: z.string(), id_token: z.string().optional() });
const providerErrorSchema = z.object({ error: z.union([z.string(), z.object({ code: z.string().optional(), param: z.string().optional() })]) });
type Saved = z.infer<typeof savedSchema>;
export type ChatGptStatus = {
  status: 'loading' | 'signed-out' | 'signing-in' | 'signed-in';
  email: string | null; planUsage: boolean; error: string | null;
};
export type ChatGptModel = { id: string; label: string };
export type ChatGptNative = {
  start(): Promise<string>;
  open(url: string): Promise<string | null>;
  cancel(): Promise<void>;
  random(): Promise<string>;
  challenge(verifier: string): Promise<string>;
  hostId(): Promise<string>;
};
class AuthError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

/** Native owns only the browser/listener and cryptography; this service owns OAuth and the Keychain record. */
export class ChatGptAuth {
  private saved: Saved | null = null;
  private access: { token: string; expiresAt: number; idToken?: string } | null = null;
  private state: ChatGptStatus = { status: 'loading', email: null, planUsage: false, error: null };
  private listeners = new Set<() => void>();
  private initialization: Promise<void> | null = null;
  private refresh: Promise<void> | null = null;
  private pending: AbortController | null = null;
  private revision = 0;
  private writes = Promise.resolve();

  constructor(private readonly deps: {
    fetch: Fetch; native: ChatGptNative;
    storage: { get(): Promise<string | null>; set(value: string): Promise<void>; remove(): Promise<void> };
    now: () => number;
  }) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private now() { return this.deps.now(); }
  private update(error: string | null = null, signingIn = false) {
    this.state = { status: signingIn ? 'signing-in' : this.saved?.account ? 'signed-in' : 'signed-out',
      email: this.saved?.account?.email ?? null, planUsage: this.saved?.account?.scopes.includes(PLAN_SCOPE) ?? false, error };
    for (const listener of this.listeners) listener();
  }
  initialize = (): Promise<void> => {
    this.initialization ??= (async () => {
      try {
        const raw = await this.deps.storage.get();
        if (raw) this.saved = savedSchema.parse(JSON.parse(raw));
        this.update();
      } catch { this.update('Could not load the ChatGPT account from secure storage. Try signing in again.'); }
    })();
    return this.initialization;
  };

  // Serialize Keychain writes so a late refresh can never overwrite a sign-out.
  private async persist(saved: Saved, revision: number): Promise<void> {
    const write = this.writes.catch(() => {}).then(async () => {
      if (revision !== this.revision) throw new AuthError('ChatGPT sign-in was cancelled.');
      await this.deps.storage.set(JSON.stringify(saved));
      if (revision !== this.revision) throw new AuthError('ChatGPT sign-in was cancelled.');
      this.saved = saved;
    });
    this.writes = write;
    await write;
  }

  signIn = async (): Promise<void> => {
    await this.initialize();
    if (this.pending) return;
    const pending = new AbortController();
    this.pending = pending;
    const revision = ++this.revision;
    const previous = this.saved;
    this.update(null, true);
    try {
      const [state, nonce, verifier] = await Promise.all([
        this.deps.native.random(), this.deps.native.random(), this.deps.native.random(),
      ]);
      const saved: Saved = previous ?? { clientId: null, hostId: `urn:uuid:${await this.deps.native.hostId()}`, identity: null, account: null };
      await this.persist(saved, revision);
      const redirectUri = await this.deps.native.start();
      pending.signal.throwIfAborted();
      const url = new URL(`${AUTH}/api/accounts/authorize`);
      url.search = new URLSearchParams({ client_id: saved.clientId ?? 'dynamic_agent_client',
        ...(!saved.clientId ? { agent_name_hint: 'Shuddhalekhan' } : {}),
        ext_agent_host_id: saved.hostId, ...(saved.identity ? { login_hint: saved.identity.email } : {}),
        ...(this.access?.idToken ? { id_token_hint: this.access.idToken } : {}),
        response_type: 'code', redirect_uri: redirectUri,
        scope: `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`, resource: RESOURCE,
        state, nonce, code_challenge_method: 'S256', code_challenge: await this.deps.native.challenge(verifier),
      }).toString();
      pending.signal.throwIfAborted();
      const callback = await this.deps.native.open(url.toString());
      if (callback === null || pending.signal.aborted) { this.update(); return; }
      const query = new URL(callback);
      if (query.protocol !== 'shuddhalekhan:' || query.hostname !== 'chatgpt-auth' || query.pathname !== ''
        || query.username || query.password || query.port || query.hash) throw new AuthError('ChatGPT callback was invalid. Please try again.');
      const keys = new Set<string>();
      for (const [key] of query.searchParams) {
        if (keys.has(key)) throw new AuthError('ChatGPT callback contained duplicate keys. Please try again.');
        keys.add(key);
      }
      if (query.searchParams.get('state') !== state) throw new AuthError('ChatGPT sign-in state did not match. Please try again.');
      if (query.searchParams.has('error')) throw new AuthError(query.searchParams.get('error') === 'access_denied'
        ? 'ChatGPT sign-in was denied. Please try again when ready.' : 'ChatGPT sign-in failed. Please try again.');
      const clientId = query.searchParams.get('client_id') ?? saved.clientId;
      const code = query.searchParams.get('code');
      if (!clientId || clientId === 'dynamic_agent_client' || !code || (saved.clientId && saved.clientId !== clientId)) throw new AuthError('ChatGPT registration was incomplete or changed. Please try again.');
      await this.persist({ ...saved, clientId }, revision);
      const data = tokenSchema.parse(await this.json(`${AUTH}/api/accounts/oauth/token`, {
        method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
          code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: pending.signal,
      }));
      if (!data.id_token) throw new AuthError('ChatGPT did not return a verifiable identity.');
      const identity = this.verifyIdentity(data.id_token, clientId, nonce);
      if (saved.identity && (saved.identity.issuer !== identity.issuer || saved.identity.subject !== identity.subject)) throw new AuthError('The ChatGPT account does not match this saved registration. Sign in with the original account.');
      await this.persist({ ...saved, clientId, identity, account: { ...identity, refreshToken: data.refresh_token, scopes: data.scope.split(/\s+/).filter(Boolean) } }, revision);
      this.access = { token: data.access_token, expiresAt: this.now() + data.expires_in * 1000, idToken: data.id_token };
      this.update();
    } catch (error) {
      if (revision === this.revision) this.update(error instanceof AuthError ? error.message : 'ChatGPT sign-in could not be completed. Please try again.');
    } finally {
      await this.deps.native.cancel().catch(() => {});
      if (this.pending === pending) this.pending = null;
    }
  };

  signOut = async (): Promise<void> => {
    await this.initialize();
    const saved = this.saved;
    const revision = ++this.revision;
    this.pending?.abort();
    this.access = null;
    this.saved = saved ? { ...saved, account: null } : null;
    this.update();
    await this.deps.native.cancel().catch(() => {});
    try {
      if (revision === this.revision) {
        if (this.saved) await this.persist(this.saved, revision);
        else await this.deps.storage.remove();
      }
    } catch {
      if (revision === this.revision) {
        try { await this.deps.storage.remove(); }
        catch { this.update('Could not clear the saved ChatGPT session. Sign out again before closing the app.'); }
      }
    }
    if (saved?.account && saved.clientId) {
      await this.json(`${AUTH}/api/accounts/oauth/revoke`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: saved.account.refreshToken, token_type_hint: 'refresh_token', client_id: saved.clientId }).toString(),
      }).catch(() => {});
    }
  };

  getAccessToken = async (): Promise<string> => {
    await this.initialize();
    this.requireAccount();
    if (!this.access || this.access.expiresAt - this.now() < 300_000) {
      this.refresh ??= this.refreshTokens().finally(() => { this.refresh = null; });
      await this.refresh;
    }
    this.requireAccount();
    if (!this.access) throw new AuthError('Sign in with ChatGPT again in Settings.');
    return this.access.token;
  };
  private requireAccount() {
    if (!this.saved?.account) throw new AuthError('Sign in with ChatGPT in Settings.');
    if (!this.saved.account.scopes.includes(PLAN_SCOPE)) throw new AuthError('ChatGPT plan usage is not enabled. Sign in again and allow plan usage.');
  }
  private async refreshTokens() {
    const saved = this.saved;
    if (!saved?.account || !saved.clientId) throw new AuthError('Sign in with ChatGPT in Settings.');
    const revision = this.revision;
    try {
      const data = tokenSchema.parse(await this.json(`${AUTH}/api/accounts/oauth/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: saved.clientId, refresh_token: saved.account.refreshToken, resource: RESOURCE }).toString(),
      }));
      await this.persist({ ...saved, account: { ...saved.account, refreshToken: data.refresh_token, scopes: data.scope.split(/\s+/).filter(Boolean) } }, revision);
      this.access = { token: data.access_token, expiresAt: this.now() + data.expires_in * 1000, idToken: this.access?.idToken };
      this.update();
    } catch (error) {
      if (error instanceof AuthError && expiredGrants.has(error.code ?? '') && revision === this.revision) await this.signOut();
      throw new AuthError('ChatGPT session could not be refreshed. Sign in with ChatGPT again in Settings.');
    }
  }

  listModels = async (): Promise<ChatGptModel[]> => {
    const token = await this.getAccessToken();
    try {
      const data = z.object({ models: z.array(z.object({ slug: z.string().min(1), display_name: z.string(), visibility: z.string() })) })
        .parse(await this.json(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } }));
      return data.models.filter(model => model.visibility === 'list').map(model => ({ id: model.slug, label: model.display_name }));
    } catch (error) {
      throw new AuthError(error instanceof AuthError ? error.message : 'ChatGPT models could not be loaded. Try again or sign in again.');
    }
  };

  private verifyIdentity(token: string, clientId: string, nonce: string) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3 || !parts[1]) throw new Error();
      const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')), char => char.charCodeAt(0));
      // OIDC Core 3.1.3.7: TLS authenticates an ID token received directly from the token endpoint.
      const claims = z.object({ iss: z.literal(AUTH), sub: z.string().min(1), email: z.email(),
        aud: z.union([z.string(), z.array(z.string()).min(1)]), azp: z.string().optional(),
        exp: z.number().finite(), nonce: z.literal(nonce) }).parse(JSON.parse(new TextDecoder().decode(bytes)));
      const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
      if (!audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId)
        || (claims.azp !== undefined && claims.azp !== clientId) || claims.exp * 1000 <= this.now()) throw new Error();
      return { issuer: claims.iss, subject: claims.sub, email: claims.email };
    } catch { throw new AuthError('ChatGPT identity could not be verified. Please sign in again.'); }
  }

  private async json(url: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 30_000);
    try {
      if (init.signal?.aborted) controller.abort();
      const response = await this.deps.fetch(url, { ...init, redirect: 'error', credentials: 'omit', signal: controller.signal });
      if (!response.ok) {
        const data = providerErrorSchema.safeParse(await response.json().catch(() => null));
        const code = data.success ? typeof data.data.error === 'string' ? data.data.error : data.data.error.code : undefined;
        throw new AuthError(chatGptError(response.status, code), code);
      }
      if (url.endsWith('/revoke')) return null;
      return await response.json();
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError('ChatGPT could not complete the request. Check your connection and try again.');
    } finally { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }
  }
}

export function chatGptError(status: number, code?: string): string {
  if (status === 401 || code === 'subscription_sharing_invalid_user' || expiredGrants.has(code ?? '')) return 'The ChatGPT account authorization is no longer valid. Sign in with ChatGPT again in Settings.';
  if (status === 429 || code === 'subscription_sharing_usage_limit_exceeded') return 'Your ChatGPT plan usage limit was reached. Manage usage at https://chatgpt.com/settings/usage before retrying.';
  if (code === 'subscription_sharing_user_not_eligible') return 'This ChatGPT account is not eligible for plan usage. Check your account and plan, then sign in again.';
  if (/^subscription_sharing_(usage|user)_unavailable$/.test(code ?? '')) return 'ChatGPT plan usage is temporarily unavailable. Try again later.';
  if (code === 'subscription_sharing_unsupported_capability') return 'ChatGPT plan usage does not support a requested capability. Review the model settings.';
  if (code === 'subscription_sharing_route_not_supported') return 'ChatGPT plan usage requires the Responses API with streaming enabled.';
  if (/^chatpass_v2_(scope_not_authorized|invalid_authorization_context)$/.test(code ?? '')) return 'ChatGPT plan usage is not authorized. Sign in again and allow plan usage.';
  if (code === 'invalid_client') return 'ChatGPT registration is invalid. Check the app configuration and sign in again.';
  return `ChatGPT could not complete the request (HTTP ${status}). Try again or sign in again.`;
}
