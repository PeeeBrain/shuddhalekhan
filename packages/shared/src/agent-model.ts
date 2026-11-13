import { createAzure } from '@ai-sdk/azure';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel, ModelMessage, SystemModelMessage, streamText } from 'ai';
import { z } from 'zod';
import { isChatGptIncludeRejection, isDeepSeekV4Provider, OPENROUTER_HEADERS } from './agent-provider';
import { agentProviderSupportsCacheBreakpoints, type AgentProviderKind } from './providers';

// Runs and probes report bounded, redacted warnings through each surface's own UI.
globalThis.AI_SDK_LOG_WARNINGS = false;
// Matches the loop's first-chunk timeout: slow reasoning endpoints may hold headers until they start answering.
const RESPONSE_HEADERS_TIMEOUT_MS = 180_000;

export type AgentModelProvider = {
  kind: AgentProviderKind;
  baseUrl: string;
  model: string;
  apiMode: 'chat-completions' | 'responses';
  auth: 'none' | 'bearer' | 'api-key';
  reasoning: 'default' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  cacheBreakpoints: boolean;
};

/** The call signature only: runtime-specific statics (Bun's `fetch.preconnect`) are never used. */
export type AgentFetch = (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => Promise<Response>;

export type AgentModelClient = {
  model: LanguageModel;
  providerOptions: NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;
  cacheMessageOptions?: SystemModelMessage['providerOptions'];
  prepareStep?: (options: { messages: ModelMessage[] }) => { messages: ModelMessage[] };
};

/**
 * Builds the AI SDK model for one validated provider. Desktop and iOS both call this, so every
 * provider quirk (ChatGPT plan body rules, cache markers, DeepSeek thinking) lives here once.
 * `fetch` is the surface's transport; it decides redirects, endpoint checks and credentials policy.
 */
export function createAgentModel(provider: AgentModelProvider, { apiKey, fetch: send = globalThis.fetch, sessionId = '' }: {
  apiKey?: string; fetch?: AgentFetch; sessionId?: string;
}): AgentModelClient {
  // The SDK's stream timeouts start only once headers arrive; this bounds the wait for them.
  const fetch: AgentFetch = async (input, init) => {
    const controller = new AbortController();
    const parent = init?.signal;
    const forward = () => controller.abort(parent?.reason);
    if (parent?.aborted) forward(); else parent?.addEventListener('abort', forward, { once: true });
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('The endpoint did not respond.'), { name: 'TimeoutError' })), RESPONSE_HEADERS_TIMEOUT_MS);
    try { return await send(input, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  };
  // Every adapter uses the selected auth mode. Never inherit a different key.
  const authenticatedFetch: AgentFetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete('authorization');
    headers.delete('api-key');
    if (provider.auth === 'bearer' && apiKey) headers.set('Authorization', `Bearer ${apiKey}`);
    if (provider.auth === 'api-key' && apiKey) headers.set('api-key', apiKey);
    if (provider.kind !== 'chatgpt' || typeof init?.body !== 'string') {
      return fetch(input, { ...init, headers, redirect: 'error' });
    }
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(init.body));
    for (const field of ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata',
      'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature',
      'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id', 'service_tier', 'prompt_cache_key']) delete body[field];
    body.store = false;
    body.stream = true;
    // The AI SDK adds `include` for store:false reasoning; retry without it if SIWC rejects it.
    const send = () => fetch(input, { ...init, body: JSON.stringify(body), headers, redirect: 'error' });
    const response = await send();
    if (response.status === 400 && body.include !== undefined) {
      const rejection = z.object({ error: z.object({ param: z.string().optional() }) })
        .safeParse(await response.clone().json().catch(() => null));
      if (rejection.success && isChatGptIncludeRejection(rejection.data.error.param ?? '')) {
        delete body.include;
        return send();
      }
    }
    return response;
  };
  const hostname = new URL(provider.baseUrl).hostname;
  const headers: Record<string, string> | undefined = hostname === 'opencode.ai'
    ? { 'x-opencode-session': sessionId, 'User-Agent': 'shuddhalekhan-agent/1.0' }
    : hostname === 'openrouter.ai'
      ? OPENROUTER_HEADERS
      : undefined;
  const settings = {
    // The SDK types this as the runtime's whole `fetch` object but only ever calls it.
    baseURL: provider.baseUrl, apiKey: apiKey ?? 'unused', headers, fetch: authenticatedFetch as typeof globalThis.fetch,
  };
  const nativeCache = provider.cacheBreakpoints && agentProviderSupportsCacheBreakpoints(provider.kind);
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
    case 'chatgpt': {
      return { model: createOpenAI(settings).responses(provider.model),
        providerOptions: { openai: { ...reasoning, store: false, systemMessageMode: 'developer' } } };
    }
    case 'openai': {
      const client = createOpenAI(settings);
      return provider.apiMode === 'responses'
        ? { model: client.responses(provider.model), providerOptions: { openai: responses }, ...cache }
        : { model: client.chat(provider.model), providerOptions: { openai: nativeOptions }, ...cache };
    }
    case 'azure-openai': {
      const client = createAzure(settings);
      return provider.apiMode === 'responses'
        ? { model: client.responses(provider.model), providerOptions: { azure: responses }, ...cache }
        : { model: client.chat(provider.model), providerOptions: { openai: nativeOptions }, ...cache };
    }
    case 'openrouter': {
      const options = provider.reasoning === 'default' ? {} : {
        extraBody: { reasoning: provider.reasoning === 'none' ? { enabled: false } : { effort: provider.reasoning } },
      };
      return { model: createOpenRouter(settings).chat(provider.model, options),
        providerOptions: { openrouter: { ...(sessionId ? { session_id: sessionId } : {}) } }, ...cache };
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
        }, ...cache,
      };
    }
    default: {
      const exhaustive: never = provider.kind;
      throw new Error(`Unknown provider: ${exhaustive}`);
    }
  }
}
