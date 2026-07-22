import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { generateKeyPairSync } from 'crypto';
import type { GoogleCloudSpeechProviderConfig } from '../../types/ipc';
import {
  buildGoogleRecognizeEndpoint,
  createGoogleCloudSpeechTranscriber,
  GOOGLE_CLOUD_SPEECH_CAPABILITIES,
  parseGoogleServiceAccount,
} from '../google-cloud-speech';

const CONFIG: GoogleCloudSpeechProviderConfig = {
  project: 'sample-project-123',
  location: 'global',
  model: 'short',
  credentialSource: 'service-account',
};

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CREDENTIAL = JSON.stringify({
  type: 'service_account',
  client_email: 'speech@sample-project-123.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  token_uri: 'https://oauth2.googleapis.com/token',
  project_id: 'sample-project-123',
});

describe('Google Cloud Speech-to-Text v2', () => {
  beforeEach(() => { globalThis.fetch = mock() as unknown as typeof fetch; });

  it('validates imported service-account documents without returning fields', () => {
    expect(parseGoogleServiceAccount(CREDENTIAL).type).toBe('service_account');
    expect(() => parseGoogleServiceAccount('{"type":"service_account"}')).toThrow(/must contain/);
    expect(() => parseGoogleServiceAccount('private_key=secret')).toThrow(/valid/);
  });

  it('constructs the implicit recognizer resource and declares the conservative duration limit', () => {
    expect(buildGoogleRecognizeEndpoint(CONFIG)).toBe(
      'https://speech.googleapis.com/v2/projects/sample-project-123/locations/global/recognizers/_:recognize',
    );
    expect(GOOGLE_CLOUD_SPEECH_CAPABILITIES.maxDurationSeconds).toBe(55);
  });

  it('authorizes internally and sends WAV recognition config, language, model, and inline hints', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof mock>;
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'short-lived-token' }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        results: [{ alternatives: [{ transcript: 'Google transcript' }] }],
      }) } as Response);

    const transcriber = createGoogleCloudSpeechTranscriber(CONFIG, CREDENTIAL);
    const wav = new Uint8Array(64);
    wav.set(new TextEncoder().encode('RIFF'));
    await expect(transcriber.transcribe({
      audio: wav,
      recognition: { language: 'hi', task: 'transcribe', dictionary: ['Shuddhalekhan'], removeFillerWords: false },
    })).resolves.toBe('Google transcript');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://oauth2.googleapis.com/token');
    const authBody = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(authBody.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(authBody.get('assertion')).toBeTruthy();

    expect(fetchMock.mock.calls[1]?.[0]).toBe(buildGoogleRecognizeEndpoint(CONFIG));
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
      Authorization: 'Bearer short-lived-token',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body.config).toEqual({
      autoDecodingConfig: {},
      languageCodes: ['hi-IN'],
      model: 'short',
      adaptation: { phraseSets: [{ inlinePhraseSet: { phrases: [{ value: 'Shuddhalekhan' }] } }] },
    });
    expect(Buffer.from(body.content, 'base64').subarray(0, 4).toString()).toBe('RIFF');
  });

  it('rejects auto-detection and translation locally without authorization or recognition requests', async () => {
    const transcriber = createGoogleCloudSpeechTranscriber(CONFIG, CREDENTIAL);
    await expect(transcriber.transcribe({
      audio: new Uint8Array(64),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    })).rejects.toMatchObject({ category: 'model' });
    await expect(transcriber.transcribe({
      audio: new Uint8Array(64),
      recognition: { language: 'en', task: 'translate', dictionary: [], removeFillerWords: false },
    })).rejects.toMatchObject({ category: 'model' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sanitizes authentication and malformed recognition failures', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'private_key=secret' } as Response);
    await expect(createGoogleCloudSpeechTranscriber(CONFIG, CREDENTIAL).transcribe({
      audio: new Uint8Array(64),
      recognition: { language: 'en', task: 'transcribe', dictionary: [], removeFillerWords: false },
    })).rejects.toMatchObject({ category: 'authentication', message: expect.not.stringContaining('secret') });
  });
});
