import type { AppConfig } from '../types/ipc';
import {
  TranscriptionFailure,
  type RecognitionSettings,
  type Transcriber,
  type TranscriptionFailureCategory,
} from './transcription';

export const LOCAL_WHISPER_CPP_CAPABILITIES = {
  translation: true,
  automaticLanguageDetection: true,
  dictionaryHints: true,
  authentication: 'none',
  maxDurationSeconds: null,
} as const;

export const localWhisperCppTranscriber: Transcriber = {
  id: 'local-whisper-cpp',
  capabilities: LOCAL_WHISPER_CPP_CAPABILITIES,
  async transcribe({ audio, recognition }) {
    const config = await loadRuntimeConfig();
    return transcribeLocalWhisper(
      audio,
      config.transcription.providers.localWhisperCpp.endpoint,
      recognition,
    );
  },
};

export async function transcribe(audioData: Uint8Array, config?: AppConfig): Promise<string> {
  const runtimeConfig = config ?? await loadRuntimeConfig();
  return transcribeLocalWhisper(audioData, runtimeConfig.whisperUrl, {
    removeFillerWords: runtimeConfig.removeFillerWords,
    language: runtimeConfig.language,
    task: runtimeConfig.task,
    dictionary: runtimeConfig.dictionary,
  });
}

async function transcribeLocalWhisper(
  audioData: Uint8Array,
  whisperUrl: string,
  recognition: RecognitionSettings,
): Promise<string> {
  const { removeFillerWords, language, task, dictionary } = recognition;

  const form = new FormData();
  const blob = new Blob([audioData], { type: 'audio/wav' });
  form.append('file', blob, 'audio.wav');
  form.append('temperature', '0.2');
  form.append('response_format', 'json');
  form.append('translate', task === 'translate' ? 'true' : 'false');

  if (language && language !== 'auto') {
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

  let response: Response;
  try {
    response = await fetch(whisperUrl, {
      method: 'POST',
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

export function cleanFillerWords(text: string): string {
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

async function loadRuntimeConfig(): Promise<AppConfig> {
  const { getConfig } = await import('./config');
  return getConfig();
}
