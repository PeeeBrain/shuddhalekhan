import { z } from 'zod';
import type { AgentProviderConfig, AgentProviderIssue, AgentProviderValidation } from '../types/ipc';
import { isAgentApiKeyEnvVarName, isDeepSeekV4Provider, isLoopbackProviderUrl, normalizeAgentProvider } from './agent-provider';

export const agentProviderSchema = z.object({
  baseUrl: z.string().default(''),
  model: z.string().default(''),
  apiKeyEnvVar: z.string().default(''),
  apiKeySource: z.enum(['environment', 'stored']).default('environment'),
  kind: z.enum(['openai', 'azure-openai', 'openrouter', 'openai-compatible']).optional(),
  apiMode: z.enum(['chat-completions', 'responses']).optional(),
  auth: z.enum(['none', 'bearer', 'api-key']).optional(),
  reasoning: z.enum(['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  allowInsecureHttp: z.boolean().default(false),
  cacheBreakpoints: z.boolean().default(false),
  thinkingEnabled: z.boolean().optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
});

export function getAgentProviderIssues(value: AgentProviderConfig): AgentProviderIssue[] {
  const parsed = agentProviderSchema.safeParse(value);
  if (!parsed.success) return [{ field: 'kind', message: 'Provider settings contain an invalid value.' }];
  const provider = normalizeAgentProvider(parsed.data);
  const issues: AgentProviderIssue[] = [];
  const add = (field: AgentProviderIssue['field'], message: string) => issues.push({ field, message });
  let url: URL | undefined;
  try { url = new URL(provider.baseUrl); } catch { add('baseUrl', 'Enter a valid HTTP or HTTPS API base URL.'); }
  if (url) {
    if (!['http:', 'https:'].includes(url.protocol)) add('baseUrl', 'The API base URL must use HTTP or HTTPS.');
    if (url.username || url.password) add('baseUrl', 'Keep credentials in secure storage or an environment variable, not the URL.');
    if (url.search || url.hash || /\/(chat\/completions|responses|completions)\/?$/i.test(url.pathname)) {
      add('baseUrl', 'Enter the API base URL, without a request route, query parameters, or fragment. Azure v1 uses /openai/v1.');
    }
    if (url.protocol === 'http:' && !isLoopbackProviderUrl(provider.baseUrl) && !provider.allowInsecureHttp) {
      add('baseUrl', 'Use HTTPS for remote providers, or explicitly allow HTTP for a trusted LAN endpoint.');
    }
    if (provider.kind === 'azure-openai' && !/\/openai\/v1$/i.test(url.pathname.replace(/\/+$/, ''))) {
      add('baseUrl', 'Azure OpenAI v1 requires a base URL ending in /openai/v1. Use the deployment name as the model.');
    }
  }
  if (!provider.model) add('model', provider.kind === 'azure-openai' ? 'Enter the Azure deployment name.' : 'Enter the model identifier.');
  if (provider.model.length > 256 || [...provider.model].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) add('model', 'The model identifier is too long or contains control characters.');
  if ((provider.kind === 'openrouter' || provider.kind === 'openai-compatible') && provider.apiMode !== 'chat-completions') {
    add('kind', 'This provider uses Chat Completions. Select OpenAI or Azure for the Responses API.');
  }
  if (provider.auth !== 'none' && provider.apiKeySource === 'environment') {
    if (!provider.apiKeyEnvVar) add('apiKeyEnvVar', 'Enter an API key environment variable name, or choose a securely saved key.');
  }
  if (provider.apiKeyEnvVar && !isAgentApiKeyEnvVarName(provider.apiKeyEnvVar)) {
    add('apiKeyEnvVar', 'Enter the environment variable name, not the API key value.');
  }
  if (isDeepSeekV4Provider(provider.baseUrl, provider.model)
    && !['default', 'none', 'high', 'max'].includes(provider.reasoning)) {
    add('reasoning', 'DeepSeek V4 supports provider default, none, high, or max reasoning.');
  }
  return issues;
}

export function resolveAgentProviderKey(
  value: AgentProviderConfig,
  storedApiKey: string | undefined,
  environment: Record<string, string | undefined>,
): { validation: AgentProviderValidation; apiKey?: string } {
  const provider = normalizeAgentProvider(value);
  const issues = getAgentProviderIssues(value);
  if (provider.auth === 'none') return { validation: { issues, credentials: 'not-required' } };
  const apiKey = provider.apiKeySource === 'stored' ? storedApiKey
    : Object.prototype.hasOwnProperty.call(environment, provider.apiKeyEnvVar) ? environment[provider.apiKeyEnvVar] : undefined;
  if (apiKey && [...apiKey.trim()].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) > 126)) {
    issues.push({ field: 'apiKeyEnvVar', message: 'The API key contains invalid header characters. Replace the saved key or environment value.' });
  }
  if (!apiKey?.trim() && !issues.some(issue => issue.field === 'apiKeyEnvVar')) {
    issues.push({
      field: 'apiKeyEnvVar',
      message: provider.apiKeySource === 'stored'
        ? 'The saved API key is unavailable. Replace it in Settings.'
        : 'The API key environment variable is unavailable to the running app. Set it before starting the app, then restart it, or use a securely saved key.',
    });
  }
  return { validation: { issues, credentials: apiKey?.trim() ? 'available' : 'missing' }, apiKey: apiKey?.trim() };
}

