import { z } from 'zod';

export const CHATGPT_AUTH = 'https://auth.openai.com';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const expiredGrantCodes = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired',
  'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
export const chatGptTokenSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1),
  expires_in: z.number().positive().finite(), scope: z.string(), id_token: z.string().optional(),
});

const diagnostics = {
  subscription_sharing_usage_limit_exceeded: { kind: 'quota', message: 'Your ChatGPT plan usage limit was reached.', action: 'Check your usage at https://chatgpt.com/settings/usage before retrying.', mobileMessage: 'Your ChatGPT plan usage limit was reached. Manage usage at https://chatgpt.com/settings/usage before retrying.' },
  subscription_sharing_user_not_eligible: { kind: 'permission', message: 'This ChatGPT account is not eligible for plan usage.', action: 'Check the account and plan in ChatGPT, then sign in again.', mobileMessage: 'This ChatGPT account is not eligible for plan usage. Check your account and plan, then sign in again.' },
  subscription_sharing_usage_unavailable: { kind: 'provider', message: 'ChatGPT plan usage is temporarily unavailable.', action: 'Try again later.', mobileMessage: 'ChatGPT plan usage is temporarily unavailable. Try again later.' },
  subscription_sharing_unsupported_capability: { kind: 'unsupported', message: 'ChatGPT plan usage does not support a requested capability.', action: 'Review the rejected parameter in the technical details and adjust the model settings.', mobileMessage: 'ChatGPT plan usage does not support a requested capability. Review the model settings.' },
  subscription_sharing_route_not_supported: { kind: 'endpoint', message: 'ChatGPT plan usage does not support this request route.', action: 'Use the Responses API with streaming enabled in the ChatGPT provider.', mobileMessage: 'ChatGPT plan usage requires the Responses API with streaming enabled.' },
  subscription_sharing_invalid_user: { kind: 'authentication', message: 'The ChatGPT account authorization is no longer valid.', action: 'Sign in with ChatGPT again in Settings.', mobileMessage: 'The ChatGPT account authorization is no longer valid. Sign in with ChatGPT again in Settings.' },
  chatpass_v2_scope_not_authorized: { kind: 'permission', message: 'ChatGPT plan usage is not authorized for this session.', action: 'Sign in with ChatGPT again and allow plan usage.', mobileMessage: 'ChatGPT plan usage is not authorized. Sign in again and allow plan usage.' },
} as const;

export function chatGptCodeDiagnostic(code: string) {
  const canonical = code === 'subscription_sharing_user_unavailable' ? 'subscription_sharing_usage_unavailable'
    : code === 'chatpass_v2_invalid_authorization_context' ? 'chatpass_v2_scope_not_authorized' : code;
  return Object.entries(diagnostics).find(([key]) => key === canonical)?.[1];
}

export function chatGptDiagnosticFromText(text: string) {
  const normalized = text.replace(/subscription_sharing_user_unavailable/g, 'subscription_sharing_usage_unavailable')
    .replace(/chatpass_v2_invalid_authorization_context/g, 'chatpass_v2_scope_not_authorized');
  return Object.entries(diagnostics).find(([code]) => normalized.includes(code))?.[1];
}

export function chatGptError(status: number, code = ''): string {
  if (status === 401 || code === 'subscription_sharing_invalid_user' || expiredGrantCodes.has(code)) return diagnostics.subscription_sharing_invalid_user.mobileMessage;
  if (status === 429) return diagnostics.subscription_sharing_usage_limit_exceeded.mobileMessage;
  const diagnostic = chatGptCodeDiagnostic(code);
  if (diagnostic) return diagnostic.mobileMessage;
  if (code === 'invalid_client') return 'ChatGPT registration is invalid. Check the app configuration and sign in again.';
  return `ChatGPT could not complete the request (HTTP ${status}). Try again or sign in again.`;
}
