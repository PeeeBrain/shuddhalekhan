import {
  buildOpenAiEndpoint,
  isValidHttpFieldName,
  type RecognitionSettings,
  type Transcriber,
  type TranscriptionCapabilities,
  type TranscriptionFailureCategory,
  TranscriptionFailure,
} from './transcription';
import { localWhisperCppTranscriber } from './whisper';
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

async function transcribeOpenAiLike(
  audioData: Uint8Array,
  recognition: RecognitionSettings,
  endpoint: string,
  model: string | undefined,
  auth: 'none' | 'bearer' | 'header',
  apiKey: string | null | undefined,
  headerName: string | undefined,
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
    form.append('language', 'en');
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

function failureForHttpStatus(status: number): TranscriptionFailure {
  let category: TranscriptionFailureCategory = 'unknown';
  let message = 'The transcription provider could not complete the request.';

  if (status === 401 || status === 403) {
    category = 'authentication';
    message = 'The transcription provider rejected authentication.';
  } else if (status === 429) {
    category = 'rate-limit';
    message = 'The transcription provider rate limit was reached. Try again later.';
  } else if (status === 404) {
    category = 'endpoint';
    message = 'The transcription endpoint was not found. Check provider settings.';
  } else if (status === 400 || status === 422) {
    category = 'model';
    message = 'The transcription provider rejected the model or recognition settings.';
  }

  return new TranscriptionFailure(category, message, status);
}

const FILLER_WORDS_PATTERN = /\b(um|uh|ah|er|hmm)\b([.,!?;])?/gi;
const DOUBLE_SPACE = /\s+/g;
const LEADING_TRAILING_SPACE = /^\s+|\s+$/g;
const PUNCTUATION_FIX = /\s+([.,!?;])/g;
const LEADING_FILLER_PUNCTUATION = /^[,\s]+/;

function cleanFillerWords(text: string): string {
  let cleaned = text.replace(FILLER_WORDS_PATTERN, (_match, _word, punctuation: string | undefined) => {
    if (!punctuation || punctuation === ',') return '';
    return punctuation;
  });
  cleaned = cleaned.replace(DOUBLE_SPACE, ' ');
  cleaned = cleaned.replace(LEADING_TRAILING_SPACE, '');
  cleaned = cleaned.replace(PUNCTUATION_FIX, '$1');
  cleaned = cleaned.replace(LEADING_FILLER_PUNCTUATION, '');
  return cleaned;
}
