export type TranscriptionProviderId = 'local-whisper-cpp';

export interface TranscriptionCapabilities {
  translation: boolean;
  automaticLanguageDetection: boolean;
  dictionaryHints: boolean;
  authentication: 'none' | 'required' | 'optional';
  maxDurationSeconds: number | null;
}

export interface RecognitionSettings {
  language: string;
  task: 'transcribe' | 'translate';
  dictionary: string[];
  removeFillerWords: boolean;
}

export interface TranscriptionRequest {
  audio: Uint8Array;
  recognition: RecognitionSettings;
}

export interface Transcriber {
  readonly id: TranscriptionProviderId;
  readonly capabilities: TranscriptionCapabilities;
  transcribe(request: TranscriptionRequest): Promise<string>;
}

export type TranscriptionFailureCategory =
  | 'authentication'
  | 'model'
  | 'endpoint'
  | 'rate-limit'
  | 'network'
  | 'malformed-response'
  | 'unknown';

export function getRecognitionCompatibilityErrors(
  settings: RecognitionSettings,
  capabilities: TranscriptionCapabilities,
): string[] {
  const errors: string[] = [];
  if (settings.task === 'translate' && !capabilities.translation) {
    errors.push('Translation is not supported by this provider.');
  }
  if (settings.language === 'auto' && !capabilities.automaticLanguageDetection) {
    errors.push('Automatic language detection is not supported by this provider.');
  }
  if (settings.dictionary.length > 0 && !capabilities.dictionaryHints) {
    errors.push('Dictionary hints are not supported by this provider.');
  }
  return errors;
}

export function validateLocalWhisperSettings(settings: { endpoint: string }): string[] {
  let url: URL;
  try {
    url = new URL(settings.endpoint);
  } catch {
    return ['Enter a valid endpoint URL.'];
  }
  return url.protocol === 'http:' || url.protocol === 'https:'
    ? []
    : ['Endpoint must use HTTP or HTTPS.'];
}

export function getSafeTranscriptionFailureMessage(error: unknown): string {
  return error instanceof TranscriptionFailure
    ? error.message
    : 'Transcription failed unexpectedly. Check provider settings and try again.';
}

export async function checkServerReachability(
  endpoint: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (validateLocalWhisperSettings({ endpoint }).length > 0) return false;
  try {
    await fetcher(endpoint, { method: 'HEAD' });
    return true;
  } catch {
    return false;
  }
}

export class TranscriptionFailure extends Error {
  constructor(
    public readonly category: TranscriptionFailureCategory,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'TranscriptionFailure';
  }
}
