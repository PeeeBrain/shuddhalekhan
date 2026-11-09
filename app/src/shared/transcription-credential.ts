import type { AppConfig, CredentialKind, TranscriptionProviderId } from '../types/ipc';

export function providerCredentialKind(
  config: AppConfig,
  provider: TranscriptionProviderId,
): CredentialKind | null {
  if (provider === 'openai') return 'openai-api-key';
  if (provider === 'sarvam') return 'sarvam-api-key';
  if (provider === 'azure-speech') return 'azure-speech-key';
  if (provider === 'google-cloud-speech-v2') {
    return config.transcription.providers.googleCloudSpeech.credentialSource === 'service-account'
      ? 'google-service-account'
      : null;
  }
  if (provider === 'nvidia-speech-nim') {
    const auth = config.transcription.providers.nvidiaSpeechNim.auth;
    return auth === 'bearer' ? 'nvidia-nim-bearer' : auth === 'header' ? 'nvidia-nim-header' : null;
  }
  if (provider === 'custom-open-ai-compatible') {
    const auth = config.transcription.providers.customOpenAiCompatible.auth;
    return auth === 'bearer'
      ? 'custom-open-ai-compatible-bearer'
      : auth === 'header'
        ? 'custom-open-ai-compatible-header'
        : null;
  }
  if (provider === 'whisper-live-kit') {
    return config.transcription.providers.whisperLiveKit.auth === 'bearer'
      ? 'whisper-live-kit-bearer'
      : null;
  }
  return null;
}
