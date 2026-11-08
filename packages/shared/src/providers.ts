/** Agent Mode providers. Each surface keys its labels and presets by these, so a new one fails typecheck until handled. */
export const AGENT_PROVIDER_KINDS = ['openai', 'azure-openai', 'openrouter', 'openai-compatible', 'chatgpt'] as const;
export type AgentProviderKind = (typeof AGENT_PROVIDER_KINDS)[number];

/** Speech-to-text providers. Desktop supports all of them; mobile records which ones it supports in its presets. */
export const TRANSCRIPTION_PROVIDER_IDS = [
  'managed-local',
  'local-whisper-cpp',
  'openai',
  'sarvam',
  'azure-speech',
  'google-cloud-speech-v2',
  'nvidia-speech-nim',
  'custom-open-ai-compatible',
  'whisper-live-kit',
] as const;
export type TranscriptionProviderId = (typeof TRANSCRIPTION_PROVIDER_IDS)[number];

/** OpenRouter and custom endpoints are reached through Chat Completions only. */
export function agentProviderUsesChatCompletionsOnly(kind: AgentProviderKind): boolean {
  return kind === 'openrouter' || kind === 'openai-compatible';
}

/** Explicit prompt-cache breakpoints exist only on native OpenAI and Azure OpenAI models. */
export function agentProviderSupportsCacheBreakpoints(kind: AgentProviderKind): boolean {
  return kind === 'openai' || kind === 'azure-openai';
}
