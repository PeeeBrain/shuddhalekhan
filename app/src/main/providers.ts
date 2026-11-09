import { DESKTOP_LANGUAGE_LOCALES, nimLocale } from '@shuddhalekhan/shared/languages';
import { createSarvamTranscriber } from './sarvam';
import {
  buildOpenAiEndpoint,
  checkServerReachability,
  getSafeTranscriptionFailureMessage,
  validateProviderReadiness,
  transcribeOpenAiLike,
  isValidHttpFieldName,
  type Transcriber,
  TranscriptionFailure,
} from './transcription';
import { createLocalWhisperCppTranscriber } from './whisper';
import { createAzureSpeechTranscriber } from './azure-speech';
import { createGoogleCloudSpeechTranscriber } from './google-cloud-speech';
import { checkWhisperLiveKitReadiness, createWhisperLiveKitTranscriber } from './whisper-live-kit';
import { getManagedLocalModelManager, managedLocalSnapshot, managedLocalTranscriber } from './managed-local';
import type { AppConfig } from '../types/ipc';
import { resolveTranscriptionFeatures } from '../shared/transcription-features';

type CredentialReader = { read: (id: string) => string | null };

/**
 * Resolves provider settings and saved credentials now, so a recording keeps
 * the provider it began with even if Settings change before it finishes.
 */
export function getTranscriber(
  config: AppConfig,
  vault: CredentialReader,
): Transcriber {
  config = structuredClone(config);
  const provider = config.transcription.activeProvider;

  if (provider === 'managed-local') return managedLocalTranscriber.forRecording();

  if (provider === 'openai') {
    return createOpenAiTranscriber(config, vault);
  }

  if (provider === 'sarvam') {
    return createSarvamTranscriber(config.transcription.providers.sarvam, vault.read('sarvam-api-key'));
  }

  if (provider === 'azure-speech') {
    return createAzureSpeechTranscriber(
      config.transcription.providers.azureSpeech,
      vault.read('azure-speech-key'),
    );
  }

  if (provider === 'google-cloud-speech-v2') {
    return createGoogleCloudSpeechTranscriber(
      config.transcription.providers.googleCloudSpeech,
      vault.read('google-service-account'),
    );
  }

  if (provider === 'nvidia-speech-nim') {
    return createNvidiaSpeechNimTranscriber(config, vault);
  }

  if (provider === 'custom-open-ai-compatible') {
    return createCustomOpenAiTranscriber(config, vault);
  }

  if (provider === 'whisper-live-kit') {
    const whisperLiveKit = config.transcription.providers.whisperLiveKit;
    return createWhisperLiveKitTranscriber(
      whisperLiveKit,
      whisperLiveKit.auth === 'bearer' ? vault.read('whisper-live-kit-bearer') : null,
    );
  }

  return createLocalWhisperCppTranscriber(config.transcription.providers.localWhisperCpp.endpoint);
}

function createOpenAiTranscriber(
  config: AppConfig,
  vault: CredentialReader,
): Transcriber {
  const features = resolveTranscriptionFeatures(config);
  const openAiConfig = config.transcription.providers.openai;
  const apiKey = vault.read('openai-api-key');
  return {
    id: 'openai',
    capabilities: { maxDurationSeconds: null },
    async transcribe({ audio, recognition, signal }) {
      if (recognition.task === 'translate' && !features.translation) {
        throw new TranscriptionFailure('model', 'The selected OpenAI model does not support file translation.');
      }
      if (!apiKey) {
        throw new TranscriptionFailure(
          'authentication',
          'OpenAI API key is not configured. Save one in Settings.',
        );
      }
      return transcribeOpenAiLike(
        audio,
        { ...recognition, dictionary: features.dictionaryHints ? recognition.dictionary : [] },
        buildOpenAiEndpoint(openAiConfig.baseUrl, recognition.task),
        openAiConfig.model,
        'bearer',
        apiKey,
        undefined,
        'openai',
        signal,
      );
    },
  };
}

function createNvidiaSpeechNimTranscriber(
  config: AppConfig,
  vault: CredentialReader,
): Transcriber {
  const nim = config.transcription.providers.nvidiaSpeechNim;
  const secret = nim.auth === 'bearer' ? vault.read('nvidia-nim-bearer')
    : nim.auth === 'header' ? vault.read('nvidia-nim-header') : null;
  return {
    id: 'nvidia-speech-nim',
    capabilities: {
      maxDurationSeconds: null,
    },
    async transcribe({ audio, recognition, signal }) {
      if (nim.auth !== 'none' && !secret) {
        throw new TranscriptionFailure('authentication', 'NVIDIA Speech NIM credentials are not configured. Save them in Settings.');
      }
      if (nim.auth === 'header' && !isValidHttpFieldName(nim.headerName)) {
        throw new TranscriptionFailure('authentication', 'NVIDIA Speech NIM header name contains invalid characters.');
      }
      const language = recognition.language === 'auto' ? 'auto' : mapNimLanguage(recognition.language);
      return transcribeOpenAiLike(
        audio,
        {
          ...recognition,
          language,
          dictionary: nim.supportsDictionaryHints ? recognition.dictionary : [],
        },
        nim.endpoint,
        nim.model,
        nim.auth,
        secret,
        nim.auth === 'header' ? nim.headerName : undefined,
        'nvidia-nim',
        signal,
      );
    },
  };
}

function createCustomOpenAiTranscriber(
  config: AppConfig,
  vault: CredentialReader,
): Transcriber {
  const features = resolveTranscriptionFeatures(config);
  const customConfig = config.transcription.providers.customOpenAiCompatible;
  const savedSecret = customConfig.auth === 'bearer' ? vault.read('custom-open-ai-compatible-bearer')
    : customConfig.auth === 'header' ? vault.read('custom-open-ai-compatible-header') : null;
  return {
    id: 'custom-open-ai-compatible',
    capabilities: { maxDurationSeconds: null },
    async transcribe({ audio, recognition, signal }) {
      if (recognition.task === 'translate' && !features.translation) {
        throw new TranscriptionFailure('model', 'Translation is not enabled for this custom endpoint.');
      }
      recognition = { ...recognition, dictionary: features.dictionaryHints ? recognition.dictionary : [] };
      const endpoint = customConfig.endpoint;
      if (!endpoint) {
        throw new TranscriptionFailure(
          'endpoint',
          'Custom OpenAI endpoint is not configured.',
        );
      }

      const { model } = customConfig;

      if (customConfig.auth === 'none') {
        return transcribeOpenAiLike(
          audio,
          recognition,
          endpoint,
          model,
          'none',
          undefined,
          undefined,
          'openai',
          signal,
        );
      }

      const apiKey = savedSecret;
      let headerName: string | undefined;

      if (customConfig.auth === 'bearer') {
        if (!apiKey) {
          throw new TranscriptionFailure(
            'authentication',
            'Bearer token is not configured for the custom OpenAI provider.',
          );
        }
      } else if (customConfig.auth === 'header') {
        headerName = customConfig.headerName;
        if (!apiKey) {
          throw new TranscriptionFailure(
            'authentication',
            'Secret header value is not configured for the custom OpenAI provider.',
          );
        }
        if (!headerName) {
          throw new TranscriptionFailure(
            'authentication',
            'Header name is not configured for the custom OpenAI provider.',
          );
        }
        if (!isValidHttpFieldName(headerName)) {
          throw new TranscriptionFailure(
            'authentication',
            'Header name contains invalid characters.',
          );
        }
      }

      return transcribeOpenAiLike(
        audio,
        recognition,
        endpoint,
        model,
        customConfig.auth,
        apiKey,
        headerName,
        'openai',
        signal,
      );
    },
  };
}

function mapNimLanguage(language: string): string {
  return nimLocale(language, DESKTOP_LANGUAGE_LOCALES[language] ?? language);
}

export async function checkTranscriptionServer(config: AppConfig): Promise<boolean> {
  const provider = config.transcription.activeProvider;

  if (provider === 'local-whisper-cpp') {
    return checkServerReachability(config.transcription.providers.localWhisperCpp.endpoint);
  }

  // OpenAI Cloud: local-only, zero fetches
  if (provider === 'openai') {
    return false;
  }

  if (provider === 'nvidia-speech-nim') {
    const { endpoint, auth } = config.transcription.providers.nvidiaSpeechNim;
    if (auth !== 'none') return false;
    return checkServerReachability(endpoint);
  }

  // Custom with auth: local-only, zero fetches
  if (provider === 'custom-open-ai-compatible') {
    const { endpoint, auth } = config.transcription.providers.customOpenAiCompatible;
    if (auth !== 'none') return false;
    return checkServerReachability(endpoint);
  }

  return false;
}

export async function checkTranscriptionReadiness(
  config: AppConfig,
  credentialVault: CredentialReader,
  onReadiness: (readiness: import('../types/ipc').TranscriptionReadiness) => void,
): Promise<import('../types/ipc').TranscriptionReadiness> {
  const provider = config.transcription.activeProvider;
  if (provider === 'managed-local') {
    const state = await getManagedLocalModelManager().getState();
    if (state.kind === 'ready') {
      try {
        await managedLocalTranscriber.warmup();
        const snapshot = await managedLocalSnapshot();
        return { providerId: provider, state: 'ready' as const,
          message: snapshot.runtime.status === 'ready'
            ? snapshot.runtime.message || `Running on ${snapshot.runtime.backend === 'cuda' ? 'NVIDIA GPU' : 'CPU'}.` :'Model files are installed. Changes apply to the next recording.',
          checkedAt: new Date().toISOString() };
      } catch (error) {
        return { providerId: provider, state: 'unavailable' as const,
          message: getSafeTranscriptionFailureMessage(error), checkedAt: new Date().toISOString() };
      }
    }
    return {
      providerId: provider,
      state: 'unavailable' as const,
      message: state.kind === 'error'
          ? state.message
          : 'Install the recommended local speech model to start Dictation.',
      checkedAt: new Date().toISOString(),
    };
  }
  if (provider !== 'whisper-live-kit') {
    const error = validateProviderReadiness(provider, config, credentialVault)[0];
    return {
      providerId: provider,
      state: error ? 'unavailable' as const : 'ready' as const,
      message: error ?? 'Settings are complete. Provider connectivity has not been checked.',
      checkedAt: new Date().toISOString(),
    };
  }

  const checking = {
    providerId: provider,
    state: 'checking' as const,
    message: 'Checking WhisperLiveKit health and PCM WebSocket readiness...',
    checkedAt: null,
  };
  onReadiness(checking);

  const providerConfig = config.transcription.providers.whisperLiveKit;
  const readiness = await checkWhisperLiveKitReadiness(
    providerConfig,
    providerConfig.auth === 'bearer' ? credentialVault.read('whisper-live-kit-bearer') : null,
  );
  onReadiness(readiness);
  return readiness;
}

export async function releaseUnusedTranscriber(previous: AppConfig, next: AppConfig): Promise<void> {
  if (previous.transcription.activeProvider === 'managed-local' && next.transcription.activeProvider !== 'managed-local') {
    await managedLocalTranscriber.shutdown().catch(error => console.warn('Managed Local shutdown failed:', error));
  }
}
