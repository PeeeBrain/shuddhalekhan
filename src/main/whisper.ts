import type { AppConfig } from '../types/ipc';

export async function transcribe(audioData: Uint8Array, config?: AppConfig): Promise<string> {
  const { whisperUrl, removeFillerWords, language, task } = config ?? await loadRuntimeConfig();

  const form = new FormData();
  const blob = new Blob([audioData], { type: 'audio/wav' });
  form.append('file', blob, 'audio.wav');
  form.append('temperature', '0.2');
  form.append('response_format', 'json');

  if (language && language !== 'auto') {
    form.append('language', language);
  }

  if (task && task !== 'transcribe') {
    form.append('task', task);
  }

  if (removeFillerWords) {
    form.append(
      'prompt',
      'The following is a clear, formal transcript without any stutters, repetitions, or filler words like um and ah.'
    );
  }

  const response = await fetch(whisperUrl, {
    method: 'POST',
    body: form as unknown as BodyInit,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(`Whisper API error: ${response.status} - ${text}`);
  }

  const data = await response.json();
  const rawText = typeof data === 'object' && data !== null && 'text' in data
    ? (data as { text?: unknown }).text
    : undefined;

  if (typeof rawText !== 'string') {
    console.warn('Whisper response did not include text:', data);
    return '';
  }

  let text = rawText.trim();

  if (removeFillerWords) {
    text = cleanFillerWords(text);
  }

  return text;
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
