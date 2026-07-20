import { createSign } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { GoogleCloudSpeechProviderConfig } from '../types/ipc';
import {
  cleanFillerWords,
  failureForHttpStatus,
  type RecognitionSettings,
  type Transcriber,
  type TranscriptionCapabilities,
  TranscriptionFailure,
} from './transcription';

export const GOOGLE_CLOUD_SPEECH_CAPABILITIES: TranscriptionCapabilities = {
  translation: false,
  automaticLanguageDetection: false,
  dictionaryHints: true,
  authentication: 'required',
  maxDurationSeconds: 55,
};

export interface GoogleServiceAccount {
  type: 'service_account';
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id?: string;
}

type AuthorizedUser = {
  type: 'authorized_user';
  client_id: string;
  client_secret: string;
  refresh_token: string;
  token_uri?: string;
};

export function parseGoogleServiceAccount(value: string): GoogleServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Select a valid Google service-account JSON document.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Select a valid Google service-account JSON document.');
  const candidate = parsed as Partial<GoogleServiceAccount>;
  if (candidate.type !== 'service_account' || !candidate.client_email?.trim()
    || !candidate.private_key?.includes('BEGIN PRIVATE KEY') || !candidate.token_uri?.startsWith('https://')) {
    throw new Error('The document must contain a service-account type, client_email, private_key, and HTTPS token_uri.');
  }
  return candidate as GoogleServiceAccount;
}

export function buildGoogleRecognizeEndpoint(config: GoogleCloudSpeechProviderConfig): string {
  const project = encodeURIComponent(config.project.trim());
  const location = encodeURIComponent(config.location.trim());
  return `https://speech.googleapis.com/v2/projects/${project}/locations/${location}/recognizers/_:recognize`;
}

const LANGUAGE_CODES: Record<string, string> = {
  en: 'en-US', hi: 'hi-IN', mr: 'mr-IN', gu: 'gu-IN', bn: 'bn-IN', ta: 'ta-IN',
  te: 'te-IN', kn: 'kn-IN', ml: 'ml-IN', pa: 'pa-IN', ur: 'ur-IN', fr: 'fr-FR',
  es: 'es-ES', de: 'de-DE', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR', pt: 'pt-BR',
  ar: 'ar-SA', ru: 'ru-RU',
};

export function createGoogleCloudSpeechTranscriber(
  config: GoogleCloudSpeechProviderConfig,
  savedCredential: string | null,
): Transcriber {
  return {
    id: 'google-cloud-speech-v2',
    capabilities: GOOGLE_CLOUD_SPEECH_CAPABILITIES,
    async transcribe({ audio, recognition }) {
      if (recognition.task === 'translate') {
        throw new TranscriptionFailure('model', 'Google Cloud Speech-to-Text v2 synchronous recognition does not translate audio.');
      }
      if (recognition.language === 'auto') {
        throw new TranscriptionFailure('model', 'Google Cloud Speech-to-Text v2 requires an explicit spoken language in Shuddhalekhan.');
      }
      const credential = config.credentialSource === 'service-account'
        ? (savedCredential ? parseGoogleServiceAccount(savedCredential) : null)
        : loadApplicationDefaultCredential();
      if (!credential) {
        throw new TranscriptionFailure('authentication', config.credentialSource === 'service-account'
          ? 'Google service-account credentials are not configured. Import them in Settings.'
          : 'Application Default Credentials could not be found. Configure ADC before recording.');
      }
      const accessToken = await obtainAccessToken(credential);
      return recognize(audio, recognition, config, accessToken);
    },
  };
}

function loadApplicationDefaultCredential(): GoogleServiceAccount | AuthorizedUser | null {
  const candidates = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'gcloud', 'application_default_credentials.json'),
  ].filter((value): value is string => Boolean(value));
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as GoogleServiceAccount | AuthorizedUser;
      if (parsed.type === 'service_account' || parsed.type === 'authorized_user') return parsed;
    } catch {
      // Continue without exposing paths or credential contents.
    }
  }
  return null;
}

async function obtainAccessToken(credential: GoogleServiceAccount | AuthorizedUser): Promise<string> {
  const form = new URLSearchParams();
  let tokenUri: string;
  if (credential.type === 'service_account') {
    tokenUri = credential.token_uri;
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: credential.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    const assertion = `${unsigned}.${signer.sign(credential.private_key, 'base64url')}`;
    form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    form.set('assertion', assertion);
  } else {
    tokenUri = credential.token_uri || 'https://oauth2.googleapis.com/token';
    form.set('grant_type', 'refresh_token');
    form.set('client_id', credential.client_id);
    form.set('client_secret', credential.client_secret);
    form.set('refresh_token', credential.refresh_token);
  }

  let response: Response;
  try {
    response = await fetch(tokenUri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  } catch {
    throw new TranscriptionFailure('network', 'Could not reach Google authentication services. Check the network connection.');
  }
  if (!response.ok) throw failureForHttpStatus(response.status, 'Google Cloud authentication');
  let data: unknown;
  try { data = await response.json(); } catch { data = null; }
  const token = data && typeof data === 'object' ? (data as { access_token?: unknown }).access_token : null;
  if (typeof token !== 'string' || !token) {
    throw new TranscriptionFailure('authentication', 'Google Cloud authentication returned an invalid response.');
  }
  return token;
}

async function recognize(
  audio: Uint8Array,
  recognition: RecognitionSettings,
  config: GoogleCloudSpeechProviderConfig,
  accessToken: string,
): Promise<string> {
  const requestConfig: Record<string, unknown> = {
    // Shuddhalekhan sends a complete 16 kHz, mono, PCM16 WAV container. Google's
    // preferred WAV path reads those decoding values from the file header.
    autoDecodingConfig: {},
    languageCodes: [LANGUAGE_CODES[recognition.language] ?? recognition.language],
    model: config.model.trim(),
  };
  if (recognition.dictionary.length) {
    requestConfig.adaptation = {
      phraseSets: [{ inlinePhraseSet: { phrases: recognition.dictionary.map((value) => ({ value })) } }],
    };
  }

  let response: Response;
  try {
    response = await fetch(buildGoogleRecognizeEndpoint(config), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: requestConfig, content: Buffer.from(audio).toString('base64') }),
    });
  } catch {
    throw new TranscriptionFailure('network', 'Could not reach Google Cloud Speech-to-Text. Check the network connection.');
  }
  if (!response.ok) throw failureForHttpStatus(response.status, 'Google Cloud Speech-to-Text');
  let data: unknown;
  try { data = await response.json(); } catch { data = null; }
  const results = data && typeof data === 'object' ? (data as { results?: unknown }).results : null;
  if (!Array.isArray(results)) throw new TranscriptionFailure('malformed-response', 'Google Cloud Speech-to-Text returned an invalid response.');
  const parts: string[] = [];
  for (const result of results) {
    const alternatives = result && typeof result === 'object' ? (result as { alternatives?: unknown }).alternatives : null;
    const transcript = Array.isArray(alternatives) && alternatives[0] && typeof alternatives[0] === 'object'
      ? (alternatives[0] as { transcript?: unknown }).transcript : null;
    if (typeof transcript !== 'string') throw new TranscriptionFailure('malformed-response', 'Google Cloud Speech-to-Text returned an invalid response.');
    if (transcript.trim()) parts.push(transcript.trim());
  }
  const text = parts.join(' ').trim();
  return recognition.removeFillerWords ? cleanFillerWords(text) : text;
}
