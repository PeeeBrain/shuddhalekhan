export const AGENT_CUSTOM_INSTRUCTIONS_LIMIT = 4000;

import { isLoopbackUrl as isLoopbackProviderUrl } from '@shuddhalekhan/shared/validation';
import { isDeepSeekV4Provider } from '@shuddhalekhan/shared/agent-provider';
export { isLoopbackProviderUrl, isDeepSeekV4Provider };
import type {
  AgentProviderConfig, AgentProviderDiagnostic,
  AgentProviderTestResult, AgentProviderValidation,
} from '../types/ipc';

export function isAgentApiKeyEnvVarName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && value.length <= 128 && !/^[A-Fa-f0-9]{32,}$/.test(value);
}

export function normalizeAgentProvider(value?: AgentProviderConfig) {
  const raw = value ?? { baseUrl: '', model: '', apiKeyEnvVar: '' };
  const baseUrl = raw.baseUrl.trim().replace(/\/+$/, '');
  const model = raw.model.trim();
  let hostname = '';
  try { hostname = new URL(baseUrl).hostname.toLowerCase(); } catch { /* Incomplete settings are editable. */ }
  const kind = raw.kind ?? (hostname === 'api.openai.com' ? 'openai'
    : hostname.endsWith('.openai.azure.com') || hostname.endsWith('.services.ai.azure.com')
      ? 'azure-openai' : hostname === 'openrouter.ai' ? 'openrouter' : 'openai-compatible');
  const keyedAuth = kind === 'azure-openai' ? 'api-key' : 'bearer';
  const auth = raw.auth ?? (raw.apiKeySource === 'stored' ? keyedAuth
    : isLoopbackProviderUrl(baseUrl) || (!baseUrl && !raw.apiKeyEnvVar.trim()) ? 'none' : keyedAuth);
  const envVar = raw.apiKeyEnvVar.trim();
  const unusedEnv = auth === 'none' || raw.apiKeySource === 'stored';
  const reasoning = raw.reasoning ?? (raw.thinkingEnabled === true
    ? isDeepSeekV4Provider(baseUrl, model) ? 'high' : raw.reasoningEffort ?? 'medium' : 'default');
  const normalized = {
    baseUrl, model, apiKeyEnvVar: unusedEnv && !isAgentApiKeyEnvVarName(envVar) ? '' : envVar, apiKeySource: raw.apiKeySource ?? 'environment',
    kind, apiMode: raw.apiMode ?? 'chat-completions', auth, reasoning,
    allowInsecureHttp: raw.allowInsecureHttp ?? false,
    cacheBreakpoints: raw.cacheBreakpoints ?? false,
  };
  return kind === 'chatgpt' ? {
    ...normalized, baseUrl: 'https://api.openai.com/v1', apiMode: 'responses' as const,
    auth: 'bearer' as const, apiKeySource: 'stored' as const, apiKeyEnvVar: '',
    allowInsecureHttp: false, cacheBreakpoints: false,
  } : normalized;
}

export type ResolvedAgentProvider = ReturnType<typeof normalizeAgentProvider>;

export function getAgentProviderRequestUrl(value: AgentProviderConfig): string | null {
  const provider = normalizeAgentProvider(value);
  if (!provider.baseUrl) return null;
  try {
    const url = new URL(provider.baseUrl);
    if (url.username || url.password || url.search || url.hash) return null;
    return new URL(`${provider.baseUrl}/${provider.apiMode === 'responses' ? 'responses' : 'chat/completions'}`).toString();
  } catch { return null; }
}

export function failedProviderTest(
  diagnostic: AgentProviderDiagnostic,
  validation: AgentProviderValidation = { issues: [], credentials: 'missing' },
): AgentProviderTestResult {
  return {
    checkedAt: new Date().toISOString(), validation,
    streaming: { status: 'not-checked', message: 'Streaming was not checked.' },
    tools: { status: 'not-checked', message: 'Tool calling was not checked.' },
    warnings: [], diagnostic,
  };
}
