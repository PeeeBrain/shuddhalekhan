import type { MobileSettings } from './settings';

type TranscriptionProvider = MobileSettings['transcriptionProvider'];
type AgentProvider = MobileSettings['agentProvider'];

/** Desktop's remote providers. `placeholder` shows the full URL this phone must reach. */
export const transcriptionProviders: { value: TranscriptionProvider; label: string; endpoint: string; model: string; placeholder: string }[] = [
  { value: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1/audio/transcriptions', model: 'gpt-4o-transcribe', placeholder: '' },
  { value: 'sarvam', label: 'Sarvam AI', endpoint: '', model: 'saaras:v4', placeholder: '' },
  { value: 'azure-speech', label: 'Azure Speech', endpoint: '', model: '', placeholder: 'https://<resource>.cognitiveservices.azure.com' },
  { value: 'google-cloud-speech-v2', label: 'Google Cloud Speech v2', endpoint: '', model: 'chirp_3', placeholder: '' },
  { value: 'nvidia-speech-nim', label: 'NVIDIA Speech NIM', endpoint: '', model: '', placeholder: 'http://192.168.1.20:9000/v1/audio/transcriptions' },
  { value: 'local-whisper-cpp', label: 'whisper.cpp server', endpoint: '', model: '', placeholder: 'http://192.168.1.20:8080/inference' },
  { value: 'whisper-live-kit', label: 'WhisperLiveKit', endpoint: '', model: '', placeholder: 'http://192.168.1.20:8000/v1/audio/transcriptions' },
  { value: 'custom-open-ai-compatible', label: 'Custom OpenAI-compatible', endpoint: '', model: '', placeholder: 'https://example.com/v1/audio/transcriptions' },
];

export const agentProviders: { value: AgentProvider; label: string; endpoint: string; model: string; placeholder: string }[] = [
  { value: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1/responses', model: 'gpt-4.1-mini', placeholder: '' },
  { value: 'azure-openai', label: 'Azure OpenAI', endpoint: '', model: '', placeholder: 'https://<resource>.openai.azure.com/openai/v1/responses' },
  { value: 'openrouter', label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: '', placeholder: '' },
  { value: 'openai-compatible', label: 'Custom OpenAI-compatible', endpoint: '', model: '', placeholder: 'http://192.168.1.20:11434/v1/chat/completions' },
];

/** Switching providers clears the old credential so it is never sent to the new service. */
export function selectTranscriptionProvider(settings: MobileSettings, provider: TranscriptionProvider): MobileSettings {
  if (settings.transcriptionProvider === provider) return settings;
  const preset = transcriptionProviders.find(option => option.value === provider)!;
  return { ...settings, transcriptionProvider: provider, transcriptionEndpoint: preset.endpoint, transcriptionModel: preset.model,
    transcriptionKey: '', googleServiceAccount: '',
    transcriptionAuth: provider === 'openai' || provider === 'custom-open-ai-compatible' ? 'bearer' : 'none' };
}

export function selectAgentProvider(settings: MobileSettings, provider: AgentProvider): MobileSettings {
  if (settings.agentProvider === provider) return settings;
  const preset = agentProviders.find(option => option.value === provider)!;
  return { ...settings, agentProvider: provider, agentEndpoint: preset.endpoint, agentModel: preset.model, agentKey: '',
    agentAuth: provider === 'azure-openai' ? 'api-key' : provider === 'openai-compatible' ? 'none' : 'bearer',
    agentApiMode: provider === 'openai' || provider === 'azure-openai' ? 'responses' : 'chat-completions',
    agentReasoning: 'default', agentCache: false };
}

/** Keeps the endpoint pointed at the selected API: `…/chat/completions` ↔ `…/responses`. */
export function selectAgentApiMode(settings: MobileSettings, mode: MobileSettings['agentApiMode']): MobileSettings {
  const [from, to] = mode === 'responses' ? ['/chat/completions', '/responses'] : ['/responses', '/chat/completions'];
  const endpoint = settings.agentEndpoint.replace(/\/+$/, '');
  return { ...settings, agentApiMode: mode, agentEndpoint: endpoint.endsWith(from) ? endpoint.slice(0, -from.length) + to : settings.agentEndpoint };
}

/** The full request URL. Sarvam and Google are fixed services; Azure accepts a resource endpoint or region. */
export function transcriptionEndpoint(settings: MobileSettings): string {
  if (settings.transcriptionProvider === 'sarvam') return 'https://api.sarvam.ai/speech-to-text';
  if (settings.transcriptionProvider === 'google-cloud-speech-v2') {
    const location = settings.googleLocation;
    // Non-global recognizers, including Chirp 3 in `us`/`eu`, only answer on their regional host.
    const host = location === 'global' ? 'speech.googleapis.com' : `${location}-speech.googleapis.com`;
    return `https://${host}/v2/projects/${encodeURIComponent(settings.googleProject)}/locations/${encodeURIComponent(location)}/recognizers/_:recognize`;
  }
  if (settings.transcriptionProvider === 'azure-speech') {
    const url = new URL(settings.transcriptionEndpoint || `https://${settings.azureRegion.toLowerCase()}.api.cognitive.microsoft.com`);
    const operation = '/speechtotext/transcriptions:transcribe';
    const path = url.pathname.replace(/\/+$/, '');
    if (!path.endsWith(operation)) url.pathname = `${path}${operation}`;
    url.searchParams.set('api-version', '2025-10-15');
    return url.toString();
  }
  return settings.transcriptionEndpoint;
}

/** Sarvam's REST API takes 30 s of audio; Google's synchronous recognize takes about a minute. */
export function recordingLimitSeconds(settings: MobileSettings): number {
  // Leave two seconds for the one-second UI timer and recorder stop latency before Sarvam's hard limit.
  if (settings.transcriptionSource === 'endpoint' && settings.transcriptionProvider === 'sarvam') return 28;
  if (settings.transcriptionSource === 'endpoint' && settings.transcriptionProvider === 'google-cloud-speech-v2') return 55;
  return 300;
}

/** Whether a remote provider has what its requests need; Settings validates the rest on save. */
export function transcriptionReady(settings: MobileSettings): boolean {
  switch (settings.transcriptionProvider) {
    case 'openai': case 'sarvam': case 'azure-speech': return settings.transcriptionKey !== '';
    case 'google-cloud-speech-v2': return settings.googleServiceAccount !== '' && settings.googleProject !== '';
    default: return settings.transcriptionEndpoint !== '';
  }
}
