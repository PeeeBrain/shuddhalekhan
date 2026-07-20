import type { AzureSpeechProviderConfig } from '../types/ipc';
import {
  type RecognitionSettings,
  type Transcriber,
  type TranscriptionCapabilities,
  cleanFillerWords,
  failureForHttpStatus,
  TranscriptionFailure,
} from './transcription';

export const AZURE_SPEECH_API_VERSION = '2025-10-15';

export const AZURE_SPEECH_CAPABILITIES: TranscriptionCapabilities = {
  translation: false,
  automaticLanguageDetection: true,
  dictionaryHints: true,
  authentication: 'required',
  maxDurationSeconds: null,
};

const AZURE_LOCALES: Record<string, string> = {
  en: 'en-US',
  hi: 'hi-IN',
  mr: 'mr-IN',
  gu: 'gu-IN',
  bn: 'bn-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  kn: 'kn-IN',
  ml: 'ml-IN',
  pa: 'pa-IN',
  ur: 'ur-IN',
  fr: 'fr-FR',
  es: 'es-ES',
  de: 'de-DE',
  ja: 'ja-JP',
  zh: 'zh-CN',
  ko: 'ko-KR',
  pt: 'pt-BR',
  ar: 'ar-SA',
  ru: 'ru-RU',
};

export function mapLanguageToAzureLocale(language: string): string | undefined {
  if (!language || language === 'auto') return undefined;
  return AZURE_LOCALES[language] ?? language;
}

export function buildAzureSpeechEndpoint(config: AzureSpeechProviderConfig): string {
  const base = config.endpoint.trim()
    || `https://${config.region.trim().toLowerCase()}.api.cognitive.microsoft.com`;
  const url = new URL(base);
  const operation = '/speechtotext/transcriptions:transcribe';
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith(operation)) url.pathname = `${path}${operation}`;
  url.searchParams.set('api-version', AZURE_SPEECH_API_VERSION);
  return url.toString();
}

export function createAzureSpeechTranscriber(
  config: AzureSpeechProviderConfig,
  apiKey: string | null,
): Transcriber {
  return {
    id: 'azure-speech',
    capabilities: AZURE_SPEECH_CAPABILITIES,
    async transcribe({ audio, recognition }) {
      if (!apiKey) {
        throw new TranscriptionFailure(
          'authentication',
          'Microsoft Azure Speech key is not configured. Save one in Settings.',
        );
      }
      return transcribeAzureSpeech(audio, recognition, buildAzureSpeechEndpoint(config), apiKey);
    },
  };
}

async function transcribeAzureSpeech(
  audioData: Uint8Array,
  recognition: RecognitionSettings,
  endpoint: string,
  apiKey: string,
): Promise<string> {
  if (recognition.task === 'translate') {
    throw new TranscriptionFailure(
      'model',
      'Translation is not supported by Microsoft Azure Speech Fast Transcription.',
    );
  }

  const definition: {
    locales?: string[];
    phraseList?: { phrases: string[] };
  } = {};
  const locale = mapLanguageToAzureLocale(recognition.language);
  if (locale) definition.locales = [locale];
  if (recognition.dictionary.length > 0) {
    definition.phraseList = { phrases: recognition.dictionary };
  }

  const form = new FormData();
  form.append('audio', new Blob([audioData], { type: 'audio/wav' }), 'audio.wav');
  form.append('definition', JSON.stringify(definition));

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': apiKey },
      body: form as unknown as BodyInit,
    });
  } catch {
    throw new TranscriptionFailure(
      'network',
      'Could not reach Microsoft Azure Speech. Check the endpoint and network connection.',
    );
  }

  if (!response.ok) throw failureForHttpStatus(response.status, 'Microsoft Azure Speech');

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new TranscriptionFailure(
      'malformed-response',
      'Microsoft Azure Speech returned an invalid response.',
    );
  }

  const combinedPhrases = typeof data === 'object' && data !== null && 'combinedPhrases' in data
    ? (data as { combinedPhrases?: unknown }).combinedPhrases
    : undefined;
  if (!Array.isArray(combinedPhrases)) {
    throw new TranscriptionFailure(
      'malformed-response',
      'Microsoft Azure Speech returned an invalid response.',
    );
  }

  const parts: string[] = [];
  for (const phrase of combinedPhrases) {
    if (typeof phrase !== 'object' || phrase === null || typeof (phrase as { text?: unknown }).text !== 'string') {
      throw new TranscriptionFailure(
        'malformed-response',
        'Microsoft Azure Speech returned an invalid response.',
      );
    }
    const text = (phrase as { text: string }).text.trim();
    if (text) parts.push(text);
  }

  let text = parts.join('\n').trim();
  if (recognition.removeFillerWords) text = cleanFillerWords(text);
  return text;
}
