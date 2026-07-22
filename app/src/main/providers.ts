import {
  buildOpenAiEndpoint,
  cleanFillerWords,
  failureForHttpStatus,
  isValidHttpFieldName,
  type RecognitionSettings,
  type Transcriber,
  type TranscriptionCapabilities,
  TranscriptionFailure,
} from './transcription';
import { localWhisperCppTranscriber } from './whisper';
import { createAzureSpeechTranscriber } from './azure-speech';
import { createGoogleCloudSpeechTranscriber } from './google-cloud-speech';
import type { AppConfig } from '../types/ipc';

type CredentialReader = { read: (id: string) => string | null };

export const OPENAI_CAPABILITIES: TranscriptionCapabilities = {
  translation: true,
  automaticLanguageDetection: true,
  dictionaryHints: true,
  authentication: 'required',
  maxDurationSeconds: null,
};

export const CUSTOM_OPENAI_CAPABILITIES: TranscriptionCapabilities = {
  translation: true,
  automaticLanguageDetection: true,
  dictionaryHints: true,
  authentication: 'optional',
  maxDurationSeconds: null,
};

export function getTranscriber(
  config: AppConfig,
  vault: CredentialReader,
): Transcriber {
  const provider = config.transcription.activeProvider;

  if (provider === 'openai') {
    return createOpenAiTranscriber(config, vault);
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

  return localWhisperCppTranscriber;
}

function createOpenAiTranscriber(
  config: AppConfig,
  vault: CredentialReader,
): Transcriber {
  return {
    id: 'openai',
    capabilities: OPENAI_CAPABILITIES,
    async transcribe({ audio, recognition }) {
      const openAiConfig = config.transcription.providers.openai;
      const apiKey = vault.read('openai-api-key');
      if (!apiKey) {
        throw new TranscriptionFailure(
          'authentication',
          'OpenAI API key is not configured. Save one in Settings.',
        );
      }
      return transcribeOpenAiLike(
        audio,
        recognition,
        buildOpenAiEndpoint(openAiConfig.baseUrl, recognition.task),
        openAiConfig.model,
        'bearer',
        apiKey,
        undefined,
      );
    },
  };
}

function createNvidiaSpeechNimTranscriber(
  config: AppConfig,
  vault: CredentialReader,
): Transcriber {
  const nim = config.transcription.providers.nvidiaSpeechNim;
  return {
    id: 'nvidia-speech-nim',
    capabilities: {
      translation: nim.supportsTranslation,
      automaticLanguageDetection: nim.supportsAutomaticLanguageDetection,
      dictionaryHints: nim.supportsDictionaryHints,
      authentication: 'optional',
      maxDurationSeconds: null,
    },
    async transcribe({ audio, recognition }) {
      let secret: string | null = null;
      if (nim.auth === 'bearer') secret = vault.read('nvidia-nim-bearer');
      if (nim.auth === 'header') secret = vault.read('nvidia-nim-header');
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
      );
    },
  };
}

function createCustomOpenAiTranscriber(
  config: AppConfig,
  vault: CredentialReader,
): Transcriber {
  return {
    id: 'custom-open-ai-compatible',
    capabilities: CUSTOM_OPENAI_CAPABILITIES,
    async transcribe({ audio, recognition }) {
      const customConfig = config.transcription.providers.customOpenAiCompatible;
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
        );
      }

      let apiKey: string | null = null;
      let headerName: string | undefined;

      if (customConfig.auth === 'bearer') {
        apiKey = vault.read('custom-open-ai-compatible-bearer');
        if (!apiKey) {
          throw new TranscriptionFailure(
            'authentication',
            'Bearer token is not configured for the custom OpenAI provider.',
          );
        }
      } else if (customConfig.auth === 'header') {
        apiKey = vault.read('custom-open-ai-compatible-header');
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
      );
    },
  };
}

const NIM_LANGUAGE_CODES: Record<string, string> = {
  en: 'en-US', hi: 'hi-IN', mr: 'mr-IN', gu: 'gu-IN', bn: 'bn-IN', ta: 'ta-IN',
  te: 'te-IN', kn: 'kn-IN', ml: 'ml-IN', pa: 'pa-IN', ur: 'ur-IN', fr: 'fr-FR',
  es: 'es-US', de: 'de-DE', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR', pt: 'pt-BR',
  ar: 'ar-SA', ru: 'ru-RU',
};

function mapNimLanguage(language: string): string {
  return NIM_LANGUAGE_CODES[language] ?? language;
}

export async function transcribeOpenAiLike(
  audioData: Uint8Array,
  recognition: RecognitionSettings,
  endpoint: string,
  model: string | undefined,
  auth: 'none' | 'bearer' | 'header',
  apiKey: string | null | undefined,
  headerName: string | undefined,
  contract: 'openai' | 'nvidia-nim' = 'openai',
): Promise<string> {
  const { removeFillerWords, language, task, dictionary } = recognition;

  // Route to correct endpoint for translation vs transcription
  const effectiveEndpoint = task === 'translate' && !endpoint.endsWith('/audio/translations')
    ? endpoint.replace(/\/audio\/transcriptions$/, '/audio/translations')
    : endpoint;

  const form = new FormData();
  const blob = new Blob([audioData], { type: 'audio/wav' });
  form.append('file', blob, 'audio.wav');

  if (model) {
    form.append('model', model);
  }

  form.append('response_format', 'json');

  if (task === 'translate') {
    if (contract === 'nvidia-nim') {
      if (language && language !== 'auto') form.append('language', language);
      form.append('target_language', 'en-US');
    } else {
      form.append('language', 'en');
    }
  } else if (language && language !== 'auto') {
    form.append('language', language);
  }

  let promptText = '';
  if (dictionary && dictionary.length > 0) {
    promptText += `Glossary: ${dictionary.join(', ')}. `;
  }
  if (removeFillerWords) {
    promptText += 'The following is a clear, formal transcript without any stutters, repetitions, or filler words like um and ah.';
  }
  if (promptText) {
    form.append('prompt', promptText.trim());
  }

  const headers: Record<string, string> = {};
  if (auth === 'bearer' && apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (auth === 'header' && apiKey && headerName) {
    headers[headerName] = apiKey;
  }

  let response: Response;
  try {
    response = await fetch(effectiveEndpoint, {
      method: 'POST',
      headers,
      body: form as unknown as BodyInit,
    });
  } catch {
    throw new TranscriptionFailure(
      'network',
      'Could not reach the transcription provider. Check the endpoint and network connection.',
    );
  }

  if (!response.ok) {
    throw failureForHttpStatus(response.status);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new TranscriptionFailure(
      'malformed-response',
      'The transcription provider returned an invalid response.',
    );
  }

  const rawText = typeof data === 'object' && data !== null && 'text' in data
    ? (data as { text?: unknown }).text
    : undefined;

  if (typeof rawText !== 'string') {
    throw new TranscriptionFailure(
      'malformed-response',
      'The transcription provider returned an invalid response.',
    );
  }

  let text = rawText.trim();

  if (removeFillerWords) {
    text = cleanFillerWords(text);
  }

  return text;
}
