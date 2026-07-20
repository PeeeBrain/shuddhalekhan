import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type TranscriptionProviderId =
  | 'local-whisper-cpp'
  | 'openai'
  | 'azure-speech'
  | 'google-cloud-speech-v2'
  | 'nvidia-speech-nim'
  | 'custom-open-ai-compatible';

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

export function validateOpenAiModel(model: string): string[] {
  const trimmed = model.trim();
  if (!trimmed) return ['Enter a model name.'];
  if (trimmed.length > 128) return ['Model name is too long (max 128 characters).'];
  // Reject control characters (0x00-0x1F, 0x7F); accept punctuation and free-form slugs
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 || code === 127) {
      return ['Model name contains control characters.'];
    }
  }
  return [];
}

export function buildOpenAiEndpoint(baseUrl: string, task?: 'transcribe' | 'translate'): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  const suffix = task === 'translate' ? '/audio/translations' : '/audio/transcriptions';
  if (normalized.endsWith(suffix)) return normalized;
  return `${normalized}${suffix}`;
}

export function validateOpenAiSettings(settings: { baseUrl: string; model: string }): string[] {
  const errors: string[] = [];
  try {
    const url = new URL(settings.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push('Base URL must use HTTP or HTTPS.');
    }
  } catch {
    errors.push('Enter a valid base URL.');
  }
  errors.push(...validateOpenAiModel(settings.model));
  return errors;
}

export function validateAzureSpeechSettings(settings: { endpoint: string; region: string }): string[] {
  const endpoint = settings.endpoint.trim();
  const region = settings.region.trim();
  if (!endpoint && !region) {
    return ['Enter a Microsoft Azure Speech resource endpoint or region.'];
  }

  const errors: string[] = [];
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'https:') errors.push('Azure resource endpoint must use HTTPS.');
    } catch {
      errors.push('Enter a valid Azure resource endpoint URL.');
    }
  }
  if (region && !/^[a-z0-9-]{2,64}$/i.test(region)) {
    errors.push('Azure region may contain only letters, numbers, and hyphens.');
  }
  return errors;
}

export function validateGoogleCloudSpeechSettings(settings: { project: string; location: string; model: string }): string[] {
  const errors: string[] = [];
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(settings.project.trim())) {
    errors.push('Enter a valid Google Cloud project ID.');
  }
  if (!/^[a-z0-9-]{1,63}$/.test(settings.location.trim())) {
    errors.push('Enter a valid Google Cloud location.');
  }
  errors.push(...validateOpenAiModel(settings.model));
  return errors;
}

export function validateNvidiaSpeechNimSettings(settings: { endpoint: string; model: string; auth: string; headerName?: string }): string[] {
  return validateCustomOpenAiSettings(settings).map((error) => error.replace('Custom', 'NVIDIA Speech NIM'));
}

export function validateCustomOpenAiSettings(settings: { endpoint: string; model: string; auth: string; headerName?: string }): string[] {
  const errors: string[] = [];
  try {
    const url = new URL(settings.endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push('Endpoint must use HTTP or HTTPS.');
    }
  } catch {
    errors.push('Enter a valid endpoint URL.');
  }
  if (settings.auth === 'header' && !settings.headerName?.trim()) {
    errors.push('Header name is required when auth is set to Header.');
  }
  errors.push(...validateOpenAiModel(settings.model));
  return errors;
}

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~\w]+$/;

export function isValidHttpFieldName(name: string): boolean {
  return HTTP_TOKEN.test(name);
}

export function validateProviderReadiness(
  providerId: TranscriptionProviderId,
  config: import('../types/ipc').AppConfig,
  vault: { read: (id: string) => string | null },
): string[] {
  const errors: string[] = [];

  if (providerId === 'local-whisper-cpp') {
    const { endpoint } = config.transcription.providers.localWhisperCpp;
    if (!endpoint.trim()) errors.push('Local endpoint is not configured.');
    else if (validateLocalWhisperSettings({ endpoint }).length > 0) errors.push('Local endpoint is invalid.');
  }

  if (providerId === 'openai') {
    const { baseUrl, model } = config.transcription.providers.openai;
    if (!baseUrl.trim()) errors.push('OpenAI base URL is not configured.');
    if (!model.trim()) errors.push('OpenAI model is not configured.');
    const apiKey = vault.read('openai-api-key');
    if (!apiKey) errors.push('OpenAI API key is not configured. Save one in Settings.');
  }

  if (providerId === 'azure-speech') {
    const azure = config.transcription.providers.azureSpeech;
    errors.push(...validateAzureSpeechSettings(azure));
    if (!vault.read('azure-speech-key')) {
      errors.push('Microsoft Azure Speech key is not configured. Save one in Settings.');
    }
    if (config.task === 'translate') {
      errors.push('Translation is not supported by Microsoft Azure Speech Fast Transcription.');
    }
  }

  if (providerId === 'google-cloud-speech-v2') {
    const google = config.transcription.providers.googleCloudSpeech;
    errors.push(...validateGoogleCloudSpeechSettings(google));
    if (google.credentialSource === 'service-account' && !vault.read('google-service-account')) {
      errors.push('Google service-account credentials are not configured. Import them in Settings.');
    }
    if (google.credentialSource === 'adc') {
      const adcPaths = [
        process.env.GOOGLE_APPLICATION_CREDENTIALS,
        join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'gcloud', 'application_default_credentials.json'),
      ].filter((value): value is string => Boolean(value));
      if (!adcPaths.some((path) => existsSync(path))) {
        errors.push('Application Default Credentials could not be found. Configure ADC before recording.');
      }
    }
    if (config.language === 'auto') errors.push('Google Cloud Speech-to-Text requires an explicit spoken language.');
    if (config.task === 'translate') errors.push('Translation is not supported by Google Cloud Speech-to-Text synchronous recognition.');
  }

  if (providerId === 'nvidia-speech-nim') {
    const nim = config.transcription.providers.nvidiaSpeechNim;
    errors.push(...validateNvidiaSpeechNimSettings(nim));
    if (nim.auth === 'bearer' && !vault.read('nvidia-nim-bearer')) errors.push('NVIDIA Speech NIM Bearer token is not configured.');
    if (nim.auth === 'header' && !vault.read('nvidia-nim-header')) errors.push('NVIDIA Speech NIM custom header secret is not configured.');
    if (nim.auth === 'header' && !isValidHttpFieldName(nim.headerName.trim())) errors.push('NVIDIA Speech NIM header name is invalid.');
    if (config.language === 'auto' && !nim.supportsAutomaticLanguageDetection) errors.push('Automatic language detection is not enabled for this NIM model.');
    if (config.task === 'translate' && !nim.supportsTranslation) errors.push('Translation is not enabled for this NIM model.');
    if (config.dictionary.length && !nim.supportsDictionaryHints) errors.push('Dictionary hints are not enabled for this NIM model.');
  }

  if (providerId === 'custom-open-ai-compatible') {
    const { endpoint, model, auth, headerName } = config.transcription.providers.customOpenAiCompatible;
    if (!endpoint.trim()) errors.push('Custom endpoint is not configured.');
    if (!model.trim()) errors.push('Custom model is not configured.');
    if (auth === 'bearer') {
      const token = vault.read('custom-open-ai-compatible-bearer');
      if (!token) errors.push('Bearer token is not configured.');
    }
    if (auth === 'header') {
      const secret = vault.read('custom-open-ai-compatible-header');
      if (!secret) errors.push('Custom header secret is not configured.');
      if (!headerName.trim()) errors.push('Header name is not configured.');
      else if (!isValidHttpFieldName(headerName.trim())) errors.push('Header name contains invalid characters.');
    }
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

export function failureForHttpStatus(
  status: number,
  providerName = 'The transcription provider',
): TranscriptionFailure {
  let category: TranscriptionFailureCategory = 'unknown';
  let message = `${providerName} could not complete the request.`;

  if (status === 401 || status === 403) {
    category = 'authentication';
    message = `${providerName} rejected authentication.`;
  } else if (status === 429) {
    category = 'rate-limit';
    message = `${providerName} rate limit was reached. Try again later.`;
  } else if (status === 404) {
    category = 'endpoint';
    message = `${providerName} endpoint was not found. Check provider settings.`;
  } else if (status === 400 || status === 422) {
    category = 'model';
    message = `${providerName} rejected the model or recognition settings.`;
  }

  return new TranscriptionFailure(category, message, status);
}

const FILLER_WORDS_PATTERN = /\b(um|uh|ah|er|hmm)\b([.,!?;])?/gi;

export function cleanFillerWords(text: string): string {
  let cleaned = text.replace(FILLER_WORDS_PATTERN, (_match, _word, punctuation: string | undefined) => {
    if (!punctuation || punctuation === ',') return '';
    return punctuation;
  });
  cleaned = cleaned.replace(/\s+/g, ' ');
  cleaned = cleaned.trim();
  cleaned = cleaned.replace(/\s+([.,!?;])/g, '$1');
  cleaned = cleaned.replace(/^[,\s]+/, '');
  return cleaned;
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
