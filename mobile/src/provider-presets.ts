import type { AgentProviderKind, TranscriptionProviderId } from '@shuddhalekhan/shared/providers';

type Preset = { label: string; endpoint: string; model: string; placeholder: string };
/** Managed Local runs models on the computer; iOS transcribes locally with on-device Parakeet instead. */
export type TranscriptionProvider = Exclude<TranscriptionProviderId, 'managed-local'>;

/**
 * Desktop's remote providers, in picker order. `placeholder` shows the full URL this phone must reach.
 * A new shared provider fails typecheck here until it gets a preset or is excluded above.
 */
export const transcriptionPresets = {
  openai: { label: 'OpenAI', endpoint: 'https://api.openai.com/v1/audio/transcriptions', model: 'gpt-4o-transcribe', placeholder: '' },
  sarvam: { label: 'Sarvam AI', endpoint: '', model: 'saaras:v4', placeholder: '' },
  'azure-speech': { label: 'Azure Speech', endpoint: '', model: '', placeholder: 'https://<resource>.cognitiveservices.azure.com' },
  'google-cloud-speech-v2': { label: 'Google Cloud Speech v2', endpoint: '', model: 'chirp_3', placeholder: '' },
  'nvidia-speech-nim': { label: 'NVIDIA Speech NIM', endpoint: '', model: '', placeholder: 'http://192.168.1.20:9000/v1/audio/transcriptions' },
  'local-whisper-cpp': { label: 'whisper.cpp server', endpoint: '', model: '', placeholder: 'http://192.168.1.20:8080/inference' },
  'whisper-live-kit': { label: 'WhisperLiveKit', endpoint: '', model: '', placeholder: 'http://192.168.1.20:8000/v1/audio/transcriptions' },
  'custom-open-ai-compatible': { label: 'Custom OpenAI-compatible', endpoint: '', model: '', placeholder: 'https://example.com/v1/audio/transcriptions' },
} satisfies Record<TranscriptionProvider, Preset>;

export const agentPresets = {
  chatgpt: { label: 'ChatGPT plan', endpoint: 'https://api.openai.com/v1/responses', model: '', placeholder: '' },
  openai: { label: 'OpenAI', endpoint: 'https://api.openai.com/v1/responses', model: 'gpt-4.1-mini', placeholder: '' },
  'azure-openai': { label: 'Azure OpenAI', endpoint: '', model: '', placeholder: 'https://<resource>.openai.azure.com/openai/v1/responses' },
  openrouter: { label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: '', placeholder: '' },
  'openai-compatible': { label: 'Custom OpenAI-compatible', endpoint: '', model: '', placeholder: 'http://192.168.1.20:11434/v1/chat/completions' },
} satisfies Record<AgentProviderKind, Preset>;

export const MOBILE_TRANSCRIPTION_PROVIDERS = Object.keys(transcriptionPresets) as TranscriptionProvider[];
export const transcriptionProviders = MOBILE_TRANSCRIPTION_PROVIDERS.map(value => ({ value, ...transcriptionPresets[value] }));
export const agentProviders = (Object.keys(agentPresets) as AgentProviderKind[]).map(value => ({ value, ...agentPresets[value] }));
