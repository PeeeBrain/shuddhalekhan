import type { AgentProviderKind } from '@shuddhalekhan/shared/providers';
import { clearedSecrets, type MobileSettings } from './settings';
import { transcriptionPresets, agentPresets, type TranscriptionProvider } from './provider-presets';
export { MOBILE_TRANSCRIPTION_PROVIDERS, transcriptionProviders, agentProviders } from './provider-presets';

/** Switching providers clears the old credential so it is never sent to the new service. */
export function selectTranscriptionProvider(settings: MobileSettings, provider: TranscriptionProvider): MobileSettings {
  if (settings.transcriptionProvider === provider) return settings;
  const preset = transcriptionPresets[provider];
  return { ...settings, transcriptionProvider: provider, transcriptionEndpoint: preset.endpoint, transcriptionModel: preset.model,
    ...clearedSecrets('transcription'),
    transcriptionAuth: provider === 'openai' || provider === 'custom-open-ai-compatible' ? 'bearer' : 'none' };
}

export function selectAgentProvider(settings: MobileSettings, provider: AgentProviderKind): MobileSettings {
  if (settings.agentProvider === provider) return settings;
  const preset = agentPresets[provider];
  return { ...settings, agentProvider: provider, agentEndpoint: preset.endpoint, agentModel: preset.model, ...clearedSecrets('agent'),
    agentAuth: provider === 'azure-openai' ? 'api-key' : provider === 'openai-compatible' || provider === 'chatgpt' ? 'none' : 'bearer',
    agentApiMode: provider === 'openai' || provider === 'azure-openai' || provider === 'chatgpt' ? 'responses' : 'chat-completions',
    agentReasoning: 'default', agentCache: false };
}

/** Keeps the endpoint pointed at the selected API: `…/chat/completions` ↔ `…/responses`. */
export function selectAgentApiMode(settings: MobileSettings, mode: MobileSettings['agentApiMode']): MobileSettings {
  if (settings.agentProvider === 'chatgpt') return settings;
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

const standardRecordingLimits = { seconds: 300, maxBytes: 15_000_000 };
export const recordingLimits = {
  openai: standardRecordingLimits,
  // Leave two seconds for the one-second UI timer and recorder stop latency before Sarvam's hard limit.
  sarvam: { seconds: 28, maxBytes: 964_000 },
  'google-cloud-speech-v2': { seconds: 55, maxBytes: 1_900_000 },
  'azure-speech': standardRecordingLimits,
  'nvidia-speech-nim': standardRecordingLimits,
  'local-whisper-cpp': standardRecordingLimits,
  'whisper-live-kit': standardRecordingLimits,
  'custom-open-ai-compatible': standardRecordingLimits,
  'on-device': standardRecordingLimits,
} satisfies Record<TranscriptionProvider | 'on-device', typeof standardRecordingLimits>;

export function recordingLimitSeconds(settings: MobileSettings): number {
  return recordingLimits[settings.transcriptionSource === 'on-device' ? 'on-device' : settings.transcriptionProvider].seconds;
}

/** Custom servers may run without a key even when a header mode is saved. */
export function agentCredentialsReady(settings: MobileSettings): boolean {
  return settings.agentProvider === 'openai-compatible' || settings.agentAuth === 'none' || !!settings.agentKey;
}

/** Whether a remote provider has what its requests need; Settings validates the rest on save. */
export function transcriptionReady(settings: MobileSettings): boolean {
  switch (settings.transcriptionProvider) {
    case 'openai': case 'sarvam': case 'azure-speech': return settings.transcriptionKey !== '';
    case 'google-cloud-speech-v2': return settings.googleServiceAccount !== '' && settings.googleProject !== '';
    default: return settings.transcriptionEndpoint !== '';
  }
}
