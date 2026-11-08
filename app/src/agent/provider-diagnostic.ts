import { z } from 'zod';
import type { AgentProviderDiagnostic } from '../types/ipc';
import { AgentProviderConfigurationError } from './provider';

const errorSchema = z.object({
  message: z.string().optional(), statusCode: z.number().optional(), status: z.number().optional(),
  responseBody: z.unknown().optional(), data: z.unknown().optional(), cause: z.unknown().optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(), name: z.string().optional(),
  code: z.string().optional(), detail: z.string().optional(), response: z.unknown().optional(),
});

export function redactProviderText(text: string, apiKey?: string): string {
  const redacted = apiKey ? text.split(apiKey).join('[redacted]') : text;
  return redacted.replace(/\bsk-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/("?(?:api[-_]?key|authorization|(?:access|refresh|id)[-_]?token|password|secret)"?\s*[:=]\s*")([^"\r\n]*)(")/gi, '$1[redacted]$3')
    .slice(0, 4000);
}

export function providerDiagnostic(error: unknown, apiKey?: string): AgentProviderDiagnostic {
  if (error instanceof AgentProviderConfigurationError) return error.diagnostic;
  const messages: string[] = [];
  let statusCode: number | undefined;
  let requestId: string | undefined;
  let value = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 6 && !seen.has(value); depth++) {
    seen.add(value);
    const parsed = errorSchema.safeParse(value);
    if (!parsed.success) break;
    const record = parsed.data;
    if (record.message) messages.push(record.message);
    if (record.code) messages.push(record.code);
    if (record.detail) messages.push(record.detail);
    statusCode ??= record.statusCode ?? record.status;
    requestId ??= record.responseHeaders?.['x-request-id'] ?? record.responseHeaders?.['apim-request-id']
      ?? record.responseHeaders?.['x-ms-request-id'];
    for (const body of [record.responseBody, record.data, record.response]) {
      if (body !== undefined) {
        try { messages.push(typeof body === 'string' ? body : JSON.stringify(body)); } catch { /* Ignore unserializable error data. */ }
      }
    }
    value = record.cause;
  }
  const details = redactProviderText(messages.join(' | ') || (error instanceof Error ? error.message : String(error)), apiKey);
  const lower = details.toLowerCase();
  let kind: AgentProviderDiagnostic['kind'] = 'provider';
  let message = 'The model provider could not complete the request.';
  let action = 'Check the technical details and test the configured model again.';
  if (lower.includes('subscription_sharing_usage_limit_exceeded')) {
    kind = 'quota'; message = 'Your ChatGPT plan usage limit was reached.';
    action = 'Check your usage at https://chatgpt.com/settings/usage before retrying.';
  } else if (lower.includes('subscription_sharing_user_not_eligible')) {
    kind = 'permission'; message = 'This ChatGPT account is not eligible for plan usage.';
    action = 'Check the account and plan in ChatGPT, then sign in again.';
  } else if (/subscription_sharing_(?:usage|user)_unavailable/.test(lower)) {
    kind = 'provider'; message = 'ChatGPT plan usage is temporarily unavailable.';
    action = 'Try again later.';
  } else if (lower.includes('subscription_sharing_unsupported_capability')) {
    kind = 'unsupported'; message = 'ChatGPT plan usage does not support a requested capability.';
    action = 'Review the rejected parameter in the technical details and adjust the model settings.';
  } else if (lower.includes('subscription_sharing_route_not_supported')) {
    kind = 'endpoint'; message = 'ChatGPT plan usage does not support this request route.';
    action = 'Use the Responses API with streaming enabled in the ChatGPT provider.';
  } else if (lower.includes('subscription_sharing_invalid_user')) {
    kind = 'authentication'; message = 'The ChatGPT account authorization is no longer valid.';
    action = 'Sign in with ChatGPT again in Settings.';
  } else if (/chatpass_v2_(?:scope_not_authorized|invalid_authorization_context)/.test(lower)) {
    kind = 'permission'; message = 'ChatGPT plan usage is not authorized for this session.';
    action = 'Sign in with ChatGPT again and allow plan usage.';
  } else if (statusCode === 401) {
    kind = 'authentication'; message = 'The provider rejected authentication.';
    action = 'Replace the key or check the authentication mode. Azure keys belong to the selected resource.';
  } else if (statusCode === 403) {
    kind = 'permission'; message = 'The provider denied access.';
    action = 'Check deployment access, account permissions, and resource firewall or private-network restrictions.';
  } else if (statusCode === 404) {
    kind = 'endpoint'; message = 'The provider could not find the endpoint or model.';
    action = 'Check the API base URL and model. Azure requires /openai/v1 and the deployment name.';
  } else if (statusCode === 429 && /quota|insufficient_quota|billing|credit/.test(lower)) {
    kind = 'quota'; message = 'The provider reports exhausted quota or credit.';
    action = 'Check account billing and deployment quota before retrying.';
  } else if (statusCode === 429) {
    kind = 'rate-limit'; message = 'The provider rate limit was reached.';
    action = 'Wait before retrying or check the deployment rate limit.';
  } else if (/timeout|timed out/.test(lower)) {
    kind = 'timeout'; message = 'The model request timed out.';
    action = 'Check server availability and local model loading. Retry with a lower supported reasoning effort if needed.';
  } else if (statusCode === 400 || /unsupported|not supported/.test(lower)) {
    kind = 'unsupported'; message = 'The provider rejected the request settings.';
    action = 'Check reasoning and API mode. Tool calling with this model may require Responses.';
  } else if (/fetch|connect|network|dns|certificate|redirect/.test(lower)) {
    kind = 'network'; message = 'The model endpoint could not be reached.';
    action = 'Check the server, URL, network, and certificate. Redirects are blocked to protect credentials.';
  }
  return { kind, message, action, details,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(requestId ? { requestId: redactProviderText(requestId, apiKey).slice(0, 200) } : {}),
  };
}
