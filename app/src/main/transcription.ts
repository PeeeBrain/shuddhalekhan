import { providerCredentialKind } from '../shared/transcription-credential';
import { isValidHttpFieldName } from '@shuddhalekhan/shared/validation';
import { validateAzureSpeechSettings, validateGoogleCloudSpeechSettings, validateNvidiaSpeechNimSettings, validateWhisperLiveKitSettings, validateLocalWhisperSettings } from '../shared/transcription-validation';
export { validateOpenAiModel, validateAzureSpeechSettings, validateGoogleCloudSpeechSettings, validateNvidiaSpeechNimSettings, validateCustomOpenAiSettings, validateWhisperLiveKitSettings, validateLocalWhisperSettings } from '../shared/transcription-validation';
import { getSarvamSettingsErrors } from '@shuddhalekhan/shared/sarvam';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { TranscriptionProviderId } from '../types/ipc';

/** Where gcloud keeps Application Default Credentials, in lookup order. */
export function applicationDefaultCredentialPaths(): string[] {
  const configDir = process.env.CLOUDSDK_CONFIG || join(
    process.platform === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : join(homedir(), '.config'),
    'gcloud',
  );
  return [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    join(configDir, 'application_default_credentials.json'),
  ].filter((value): value is string => Boolean(value));
}
import { getTranscriptionDictionaryError, resolveTranscriptionFeatures } from '../shared/transcription-features';
export type { TranscriptionProviderId } from '../types/ipc';

export interface TranscriptionCapabilities {
  maxDurationSeconds: number | null;
}

export interface RecognitionSettings {
  language: string;
  task: 'transcribe' | 'translate';
  dictionary: string[];
  removeFillerWords: boolean;
}

export interface TranscriptionRequest {
  audio: Uint8Array<ArrayBuffer>;
  recognition: RecognitionSettings;
  /** Aborts in-flight provider requests and prevents further ones (auth, retries). */
  signal?: AbortSignal;
}

export interface StreamingTranscriptSnapshot {
  sequence: number;
  committed: string;
  tentative: string;
}

export interface StreamingTranscriptionSession {
  send(pcm: Uint8Array): Promise<void>;
  finish(): Promise<string>;
  cancel(): void;
}

export interface StreamingTranscriptionRequest {
  recognition: RecognitionSettings;
  onSnapshot: (snapshot: StreamingTranscriptSnapshot) => void;
}

export interface Transcriber {
  readonly id: TranscriptionProviderId;
  readonly capabilities: TranscriptionCapabilities;
  readonly transportCapabilities?: import('../types/ipc').TranscriptionTransportCapabilities;
  transcribe(request: TranscriptionRequest): Promise<string>;
  startStreaming?(request: StreamingTranscriptionRequest): StreamingTranscriptionSession;
}

export type TranscriptionFailureCategory =
  | 'authentication'
  | 'model'
  | 'endpoint'
  | 'rate-limit'
  | 'network'
  | 'malformed-response'
  | 'unknown';


export function buildOpenAiEndpoint(baseUrl: string, task?: 'transcribe' | 'translate'): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  const suffix = task === 'translate' ? '/audio/translations' : '/audio/transcriptions';
  if (normalized.endsWith(suffix)) return normalized;
  return `${normalized}${suffix}`;
}


export { isValidHttpFieldName } from '@shuddhalekhan/shared/validation';

export function validateProviderReadiness(
  providerId: TranscriptionProviderId,
  config: import('../types/ipc').AppConfig,
  vault: { read: (id: string) => string | null },
): string[] {
  const credentialKind = providerCredentialKind(config, providerId);
  const readCredential = () => credentialKind ? vault.read(credentialKind) : null;
  const errors: string[] = [];
  const features = resolveTranscriptionFeatures(config);
  if (config.task === 'translate' && !features.translation) errors.push('Translation is not supported by the selected provider and model.');
  if (features.language.kind === 'select' && config.language === 'auto' && !features.automaticLanguageDetection) {
    errors.push('Choose an explicit spoken language for this provider.');
  }
  const dictionaryError = getTranscriptionDictionaryError(config);
  if (dictionaryError && providerId !== 'managed-local') errors.push(dictionaryError);

  if (providerId === 'local-whisper-cpp') {
    const { endpoint } = config.transcription.providers.localWhisperCpp;
    if (!endpoint.trim()) errors.push('Local endpoint is not configured.');
    else if (validateLocalWhisperSettings({ endpoint }).length > 0) errors.push('Local endpoint is invalid.');
  }

  if (providerId === 'openai') {
    const { baseUrl, model } = config.transcription.providers.openai;
    if (!baseUrl.trim()) errors.push('OpenAI base URL is not configured.');
    if (!model.trim()) errors.push('OpenAI model is not configured.');
    const apiKey = readCredential();
    if (!apiKey) errors.push('OpenAI API key is not configured. Save one in Settings.');
  }

  if (providerId === 'sarvam') {
    errors.push(...getSarvamSettingsErrors(config.transcription.providers.sarvam, config.language, config.dictionary));
    if (!readCredential()) errors.push('Sarvam API key is not configured. Save one in Settings.');
  }

  if (providerId === 'azure-speech') {
    const azure = config.transcription.providers.azureSpeech;
    errors.push(...validateAzureSpeechSettings(azure));
    if (!readCredential()) {
      errors.push('Microsoft Azure Speech key is not configured. Save one in Settings.');
    }
    if (config.task === 'translate') {
      errors.push('Translation is not supported by Microsoft Azure Speech Fast Transcription.');
    }
  }

  if (providerId === 'google-cloud-speech-v2') {
    const google = config.transcription.providers.googleCloudSpeech;
    errors.push(...validateGoogleCloudSpeechSettings(google));
    if (google.credentialSource === 'service-account' && !readCredential()) {
      errors.push('Google service-account credentials are not configured. Import them in Settings.');
    }
    if (google.credentialSource === 'adc') {
      if (!applicationDefaultCredentialPaths().some((path) => existsSync(path))) {
        errors.push('Application Default Credentials could not be found. Configure ADC before recording.');
      }
    }
    if (config.language === 'auto') errors.push('Google Cloud Speech-to-Text requires an explicit spoken language.');
    if (config.task === 'translate') errors.push('Translation is not supported by Google Cloud Speech-to-Text synchronous recognition.');
  }

  if (providerId === 'nvidia-speech-nim') {
    const nim = config.transcription.providers.nvidiaSpeechNim;
    errors.push(...validateNvidiaSpeechNimSettings(nim));
    if (nim.auth === 'bearer' && !readCredential()) errors.push('NVIDIA Speech NIM Bearer token is not configured.');
    if (nim.auth === 'header' && !readCredential()) errors.push('NVIDIA Speech NIM custom header secret is not configured.');
    if (nim.auth === 'header' && !isValidHttpFieldName(nim.headerName.trim())) errors.push('NVIDIA Speech NIM header name is invalid.');
    if (config.language === 'auto' && !nim.supportsAutomaticLanguageDetection) errors.push('Automatic language detection is not enabled for this NIM model.');
    if (config.task === 'translate' && !nim.supportsTranslation) errors.push('Translation is not enabled for this NIM model.');
  }

  if (providerId === 'custom-open-ai-compatible') {
    const { endpoint, model, auth, headerName } = config.transcription.providers.customOpenAiCompatible;
    if (!endpoint.trim()) errors.push('Custom endpoint is not configured.');
    if (!model.trim()) errors.push('Custom model is not configured.');
    if (auth === 'bearer') {
      const token = readCredential();
      if (!token) errors.push('Bearer token is not configured.');
    }
    if (auth === 'header') {
      const secret = readCredential();
      if (!secret) errors.push('Custom header secret is not configured.');
      if (!headerName.trim()) errors.push('Header name is not configured.');
      else if (!isValidHttpFieldName(headerName.trim())) errors.push('Header name contains invalid characters.');
    }
  }

  if (providerId === 'whisper-live-kit') {
    const provider = config.transcription.providers.whisperLiveKit;
    errors.push(...validateWhisperLiveKitSettings(provider));
    if (provider.auth === 'bearer' && !readCredential()) {
      errors.push('WhisperLiveKit bearer token is not configured.');
    }
    if (config.task === 'translate') {
      errors.push('Translation is not supported by WhisperLiveKit batch transcription.');
    }
  }

  return errors;
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

export async function transcribeOpenAiLike(
  audioData: Uint8Array<ArrayBuffer>,
  recognition: RecognitionSettings,
  endpoint: string,
  model: string | undefined,
  auth: 'none' | 'bearer' | 'header',
  apiKey: string | null | undefined,
  headerName: string | undefined,
  contract: 'openai' | 'nvidia-nim' | 'whisper-cpp' = 'openai',
  signal?: AbortSignal,
): Promise<string> {
  const { removeFillerWords, language, task, dictionary } = recognition;

  const effectiveEndpoint = contract !== 'whisper-cpp' && task === 'translate' && !endpoint.endsWith('/audio/translations')
    ? endpoint.replace(/\/audio\/transcriptions$/, '/audio/translations')
    : endpoint;

  const form = new FormData();
  const blob = new Blob([audioData], { type: 'audio/wav' });
  form.append('file', blob, 'audio.wav');

  if (model) {
    form.append('model', model);
  }

  form.append('response_format', 'json');

  if (contract === 'whisper-cpp') {
    form.append('temperature', '0.2');
    form.append('translate', task === 'translate' ? 'true' : 'false');
    if (language && language !== 'auto') form.append('language', language);
  } else if (task === 'translate') {
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
      signal,
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
