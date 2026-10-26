import { z } from 'zod';
import { bearerHeaders, parseResponse, readJSON, request, type Fetch } from './network';
import { dictionaryTerms, googleServiceAccountSchema, validSecretHeader, type MobileSettings } from './settings';
import { languageBase, languageLocale, normalizeLanguage } from './languages';
import { transcriptionEndpoint } from './providers';
import { sarvamLanguageCode } from '../../app/src/shared/sarvam';

type SignGoogleJwt = (privateKey: string, input: string) => Promise<string>;

/** One recording → one provider request. Language is a hint unless the provider requires it. */
export async function transcribe({ audio, settings, signal, fetch, signGoogleJwt }: {
  audio: Blob;
  settings: MobileSettings;
  signal: AbortSignal;
  fetch: Fetch;
  signGoogleJwt?: SignGoogleJwt;
}): Promise<string> {
  signal.throwIfAborted();
  const provider = settings.transcriptionProvider;
  const language = normalizeLanguage(settings.language);
  const terms = dictionaryTerms(settings.dictionary);
  const send = (body: BodyInit, headers: Record<string, string>) => request({ fetch, endpoint: transcriptionEndpoint(settings),
    allowHTTP: settings.allowInsecureHTTP, signal, init: { method: 'POST', headers, body }, read: readJSON });
  const requireKey = () => {
    if (!settings.transcriptionKey) throw new Error('Enter the transcription provider API key in Settings.');
    return settings.transcriptionKey;
  };
  let text: string;
  if (provider === 'google-cloud-speech-v2') {
    if (!language) throw new Error('Google Cloud Speech needs an explicit spoken language.');
    // Allow recorder latency after the 55-second stop point, staying below Google's one-minute limit.
    if (audio.size > 1_900_000) throw new Error('Keep Google Cloud Speech recordings under 55 seconds.');
    const token = await googleAccessToken({ settings, signal, fetch, signGoogleJwt });
    const content = base64(new Uint8Array(await audio.arrayBuffer()));
    const data = await send(JSON.stringify({ config: {
      // A 16 kHz mono PCM16 WAV; Google reads the decoding values from its header.
      autoDecodingConfig: {}, languageCodes: [languageLocale(language)], model: settings.transcriptionModel,
      ...(terms.length ? { adaptation: { phraseSets: [{ inlinePhraseSet: { phrases: terms.map(value => ({ value })) } }] } } : {}),
    }, content }), { 'Content-Type': 'application/json', ...bearerHeaders(token) });
    const result = parseResponse(z.object({ results: z.array(z.object({ alternatives: z.array(z.object({ transcript: z.string() })).default([]) })).default([]) }), data);
    text = result.results.map(result => result.alternatives[0]?.transcript ?? '').join(' ');
  } else if (provider === 'azure-speech') {
    const form = new FormData();
    form.append('audio', audio, 'recording.wav');
    form.append('definition', JSON.stringify({ ...(language ? { locales: [languageLocale(language)] } : {}),
      ...(terms.length ? { phraseList: { phrases: terms } } : {}) }));
    const data = await send(form, { 'Ocp-Apim-Subscription-Key': requireKey() });
    text = parseResponse(z.object({ combinedPhrases: z.array(z.object({ text: z.string() })) }), data).combinedPhrases.map(phrase => phrase.text).join('\n');
  } else if (provider === 'sarvam') {
    if (audio.size > 964_000) throw new Error('Keep Sarvam recordings under 30 seconds.');
    const code = language ? sarvamLanguageCode(languageBase(language)) : undefined;
    if (language && !code) throw new Error('Choose a language supported by Sarvam, or Auto-detect.');
    const form = new FormData();
    form.append('file', audio, 'recording.wav');
    form.append('model', settings.transcriptionModel);
    form.append('mode', settings.sarvamMode);
    if (code) form.append('language_code', code);
    if (settings.transcriptionModel === 'saaras:v4' && terms.length) form.append('keyterms', JSON.stringify(terms));
    const data = await send(form, { 'api-subscription-key': requireKey() });
    text = parseResponse(z.object({ transcript: z.string().max(200_000) }), data).transcript;
  } else {
    // OpenAI's multipart contract, shared by whisper.cpp, NVIDIA NIM, WhisperLiveKit, and custom servers.
    const form = new FormData();
    form.append('file', audio, 'recording.wav');
    if (settings.transcriptionModel && provider !== 'local-whisper-cpp') form.append('model', settings.transcriptionModel);
    form.append('response_format', 'json');
    if (language) form.append('language', provider === 'nvidia-speech-nim' ? nimLocale(language) : languageBase(language));
    if (provider === 'local-whisper-cpp') form.append('temperature', '0');
    const dictionary = provider !== 'whisper-live-kit' && (provider !== 'nvidia-speech-nim' || settings.nimDictionary);
    if (dictionary && settings.dictionary.trim()) form.append('prompt', settings.dictionary.trim());
    const auth = provider === 'openai' ? 'bearer' : provider === 'local-whisper-cpp' ? 'none' : settings.transcriptionAuth;
    let headers: Record<string, string> = {};
    if (auth === 'bearer') headers = bearerHeaders(provider === 'openai' ? requireKey() : settings.transcriptionKey);
    else if (auth === 'header' && provider !== 'whisper-live-kit') {
      if (!validSecretHeader(settings.transcriptionHeaderName)) throw new Error('Enter a valid secret header name.');
      headers = { [settings.transcriptionHeaderName]: requireKey() };
    }
    const data = await send(form, headers);
    text = parseResponse(z.object({ text: z.string().max(200_000) }), data).text;
  }
  if (!text.trim()) throw new Error('No speech was recognized. Record again.');
  if (text.length > 200_000) throw new Error('The transcript is too large. Record a shorter clip.');
  return text.trim();
}

/** NVIDIA Riva names Spanish and Portuguese by their American locales. */
function nimLocale(language: string): string {
  return language === 'es' ? 'es-US' : languageLocale(language);
}

/** Exchanges a natively signed service-account JWT for a one-hour token. */
async function googleAccessToken({ settings, signal, fetch, signGoogleJwt }: {
  settings: MobileSettings; signal: AbortSignal; fetch: Fetch; signGoogleJwt?: SignGoogleJwt;
}): Promise<string> {
  if (!settings.googleServiceAccount) throw new Error('Paste your Google service-account JSON in Settings.');
  if (!signGoogleJwt) throw new Error('Google service accounts require the updated native app build.');
  let raw: unknown;
  try { raw = JSON.parse(settings.googleServiceAccount); } catch { /* Reported below without echoing the secret. */ }
  const parsed = googleServiceAccountSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Paste valid Google service-account JSON in Settings.');
  // Always Google's token endpoint: a pasted document's token_uri must not receive a signed assertion.
  const tokenEndpoint = 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => base64(new TextEncoder().encode(JSON.stringify(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: parsed.data.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform', aud: tokenEndpoint, iat: now, exp: now + 3600 })}`;
  const signature = await signGoogleJwt(parsed.data.private_key, input);
  signal.throwIfAborted();
  const data = await request({ fetch, endpoint: tokenEndpoint, allowHTTP: false, signal,
    init: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${signature}` }).toString() },
    read: readJSON }).catch((error: unknown) => {
    if (signal.aborted || !(error instanceof Error)) throw error;
    throw new Error(`Google authentication: ${error.message}`);
  });
  return parseResponse(z.object({ access_token: z.string().min(1).max(4096) }), data).access_token;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
