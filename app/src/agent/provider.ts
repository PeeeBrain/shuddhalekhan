import { createOpenAI } from '@ai-sdk/openai';
import { createAzure } from '@ai-sdk/azure';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel, ModelMessage, SystemModelMessage, streamText } from 'ai';
import type { AgentProviderConfig, AgentProviderDiagnostic } from '../types/ipc';
import { isDeepSeekV4Provider, normalizeAgentProvider } from '../shared/agent-provider';
import { resolveAgentProviderKey } from '../shared/agent-provider-validation';

// Runs and probes report bounded, redacted warnings through our own UI/audit path.
globalThis.AI_SDK_LOG_WARNINGS = false;

export class AgentProviderConfigurationError extends Error {
  constructor(readonly diagnostic: AgentProviderDiagnostic) { super(diagnostic.message); }
}

export function createAgentProvider(value: AgentProviderConfig, storedApiKey?: string, sessionId = ''): {
  model: LanguageModel;
  providerOptions: NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;
  cacheMessageOptions?: SystemModelMessage['providerOptions'];
  prepareStep?: (options: { messages: ModelMessage[] }) => { messages: ModelMessage[] };
  apiKey?: string;
} {
  const provider = normalizeAgentProvider(value);
  const { validation, apiKey } = resolveAgentProviderKey(value, storedApiKey, process.env);
  const issue = validation.issues[0];
  if (issue) throw new AgentProviderConfigurationError({
    kind: 'configuration', message: issue.message, action: 'Correct the Agent provider settings and test the model again.',
  });

  // Every adapter uses the selected auth mode. Never inherit a different key or
  // forward credentials through a redirect to an unreviewed endpoint.
  const authenticatedFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete('authorization');
    headers.delete('api-key');
    if (provider.auth === 'bearer' && apiKey) headers.set('Authorization', `Bearer ${apiKey}`);
    if (provider.auth === 'api-key' && apiKey) headers.set('api-key', apiKey);
    return fetch(input, { ...init, headers, redirect: 'error' });
  };
  const hostname = new URL(provider.baseUrl).hostname;
  const headers: Record<string, string> | undefined = hostname === 'opencode.ai'
    ? { 'x-opencode-session': sessionId, 'User-Agent': 'shuddhalekhan-agent/1.0' }
    : hostname === 'openrouter.ai'
      ? { 'HTTP-Referer': 'https://github.com/parthashirolkar/shuddhalekhan', 'X-OpenRouter-Title': 'Shuddhalekhan' }
      : undefined;
  const settings = {
    baseURL: provider.baseUrl, apiKey: apiKey ?? 'unused', headers, fetch: authenticatedFetch,
  };
  const nativeCache = provider.cacheBreakpoints && (provider.kind === 'openai' || provider.kind === 'azure-openai');
  const cacheNamespace = provider.kind === 'azure-openai' && provider.apiMode === 'responses' ? 'azure' : 'openai';
  const cacheMessageOptions: SystemModelMessage['providerOptions'] = provider.kind === 'openrouter'
    ? { openrouter: { cacheControl: { type: 'ephemeral' } } }
    : nativeCache ? { [cacheNamespace]: { promptCacheBreakpoint: { mode: 'explicit' } } } : undefined;
  const cacheOption = provider.kind === 'openrouter' ? 'cacheControl' : 'promptCacheBreakpoint';
  const namespace = provider.kind === 'openrouter' ? 'openrouter' : cacheNamespace;
  const clearCache = (options: SystemModelMessage['providerOptions']) => {
    if (!options?.[namespace]?.[cacheOption]) return options;
    const remaining = { ...options[namespace] };
    delete remaining[cacheOption];
    return { ...options, [namespace]: remaining };
  };
  const prepareStep = cacheMessageOptions
    ? ({ messages }: { messages: ModelMessage[] }) => {
      // System + the latest two input boundaries stay within Anthropic's four-marker limit.
      const boundaries = messages.flatMap((message, index) => message.role === 'user'
        || (message.role === 'tool' && message.content.some(part => part.type === 'tool-result')) ? [index] : []).slice(-2);
      return { messages: messages.map((message, index) => {
        const providerOptions = clearCache(message.providerOptions);
        if (message.role === 'tool') {
          const lastResult = message.content.map(part => part.type).lastIndexOf('tool-result');
          return { ...message, providerOptions, content: message.content.map((part, partIndex) => part.type === 'tool-result'
            ? { ...part, providerOptions: { ...clearCache(part.providerOptions),
              ...(boundaries.includes(index) && partIndex === lastResult ? cacheMessageOptions : {}) } } : part) };
        }
        if (message.role === 'user') {
          const content = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
          const lastText = content.map(part => part.type).lastIndexOf('text');
          return { ...message, providerOptions, content: content.map((part, partIndex) => part.type === 'text'
            ? { ...part, providerOptions: { ...clearCache(part.providerOptions),
              ...(boundaries.includes(index) && partIndex === lastText ? cacheMessageOptions : {}) } } : part) };
        }
        return { ...message, providerOptions };
      }) };
    } : undefined;
  const cache = { cacheMessageOptions, prepareStep };
  const reasoning = provider.reasoning === 'default' ? {} : {
    reasoningEffort: provider.reasoning, forceReasoning: true,
  };
  const nativeOptions = { ...reasoning, ...(nativeCache ? { promptCacheKey: 'shuddhalekhan-agent-v1' } : {}) };
  const responses = { ...nativeOptions, reasoningSummary: null, store: false, include: ['reasoning.encrypted_content'] };

  switch (provider.kind) {
    case 'openai': {
      const client = createOpenAI(settings);
      return provider.apiMode === 'responses'
        ? { model: client.responses(provider.model), providerOptions: { openai: responses }, apiKey, ...cache }
        : { model: client.chat(provider.model), providerOptions: { openai: nativeOptions }, apiKey, ...cache };
    }
    case 'azure-openai': {
      const client = createAzure(settings);
      return provider.apiMode === 'responses'
        ? { model: client.responses(provider.model), providerOptions: { azure: responses }, apiKey, ...cache }
        : { model: client.chat(provider.model), providerOptions: { openai: nativeOptions }, apiKey, ...cache };
    }
    case 'openrouter': {
      const options = provider.reasoning === 'default' ? {} : {
        extraBody: { reasoning: provider.reasoning === 'none' ? { enabled: false } : { effort: provider.reasoning } },
      };
      return { model: createOpenRouter(settings).chat(provider.model, options),
        providerOptions: { openrouter: { ...(sessionId ? { session_id: sessionId } : {}) } }, apiKey, ...cache };
    }
    case 'openai-compatible': {
      const client = createOpenAICompatible({
        ...settings, name: 'shuddhalekhan', apiKey,
        ...(isDeepSeekV4Provider(provider.baseUrl, provider.model) && provider.reasoning !== 'default' ? {
          transformRequestBody: (args: Record<string, unknown>) => ({
            ...args, thinking: { type: provider.reasoning === 'none' ? 'disabled' : 'enabled' },
          }),
        } : {}),
      });
      return {
        model: client.chatModel(provider.model),
        providerOptions: provider.reasoning === 'default' ? {} : {
          shuddhalekhan: { reasoningEffort: provider.reasoning },
        }, apiKey, ...cache,
      };
    }
    default: {
      const exhaustive: never = provider.kind;
      throw new Error(`Unknown provider: ${exhaustive}`);
    }
  }
}
