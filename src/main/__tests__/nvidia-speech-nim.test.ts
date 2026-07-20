import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AppConfig } from '../../types/ipc';
import { getTranscriber } from '../providers';
import { validateProviderReadiness } from '../transcription';

function config(auth: 'none' | 'bearer' | 'header' = 'none'): AppConfig {
  return {
    whisperUrl: 'http://localhost:8080/inference',
    transcription: {
      activeProvider: 'nvidia-speech-nim',
      providers: {
        localWhisperCpp: { endpoint: 'http://localhost:8080/inference' },
        openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
        azureSpeech: { endpoint: '', region: '' },
        googleCloudSpeech: { project: '', location: 'global', model: '', credentialSource: 'service-account' },
        nvidiaSpeechNim: {
          endpoint: 'http://localhost:9000/v1/audio/transcriptions', model: 'nvidia/parakeet', auth,
          headerName: auth === 'header' ? 'X-API-Key' : '', supportsAutomaticLanguageDetection: false,
          supportsTranslation: false, supportsDictionaryHints: true,
        },
        customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
      },
    },
    selectedDeviceId: null, removeFillerWords: false, language: 'en', task: 'transcribe', dictionary: [],
    pasteStrategy: { default: 'ctrl-v', overrides: {} }, setupChecklistDismissed: true,
    recordingActivationMode: 'push-to-talk',
    shortcuts: {
      dictation: { binding: { keyCode: null, modifiers: ['ctrl', 'win'] }, activationMode: 'push-to-talk' },
      agent: { binding: { keyCode: null, modifiers: ['alt', 'win'] }, activationMode: 'push-to-talk' },
    },
    agent: { enabled: false, provider: { baseUrl: '', model: '', apiKeyEnvVar: '', thinkingEnabled: true }, mcpServers: [] },
  };
}

const request = {
  audio: new Uint8Array([1, 2, 3]),
  recognition: { language: 'en', task: 'transcribe' as const, dictionary: ['Shuddhalekhan'], removeFillerWords: false },
};

describe('NVIDIA Speech NIM', () => {
  beforeEach(() => { globalThis.fetch = mock() as unknown as typeof fetch; });

  it('uses the OpenAI-compatible offline multipart contract with a free-form model', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ text: 'NIM transcript' }) } as Response);
    const transcriber = getTranscriber(config(), { read: () => null });
    await expect(transcriber.transcribe(request)).resolves.toBe('NIM transcript');

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:9000/v1/audio/transcriptions', expect.objectContaining({ method: 'POST', headers: {} }));
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get('file')).toBeInstanceOf(Blob);
    expect(body.get('model')).toBe('nvidia/parakeet');
    expect(body.get('language')).toBe('en-US');
    expect(body.get('prompt')).toBe('Glossary: Shuddhalekhan.');
    expect(body.get('response_format')).toBe('json');
  });

  it('supports optional Bearer and custom-header authentication without exposing secrets', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ text: 'ok' }) } as Response);
    await getTranscriber(config('bearer'), { read: () => 'bearer-secret' }).transcribe(request);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: 'Bearer bearer-secret' });
    await getTranscriber(config('header'), { read: () => 'header-secret' }).transcribe(request);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ 'X-API-Key': 'header-secret' });
  });

  it('derives recognition capabilities from the selected deployment configuration', () => {
    const configured = config();
    configured.transcription.providers.nvidiaSpeechNim.supportsTranslation = true;
    configured.transcription.providers.nvidiaSpeechNim.supportsAutomaticLanguageDetection = true;
    const transcriber = getTranscriber(configured, { read: () => null });
    expect(transcriber.capabilities).toMatchObject({
      translation: true, automaticLanguageDetection: true, dictionaryHints: true, authentication: 'optional',
    });
  });

  it('validates endpoint, model, capability, and credential readiness locally', () => {
    const bearer = config('bearer');
    expect(validateProviderReadiness('nvidia-speech-nim', bearer, { read: () => null })).toContain('NVIDIA Speech NIM Bearer token is not configured.');
    expect(validateProviderReadiness('nvidia-speech-nim', bearer, { read: () => 'secret' })).toEqual([]);
  });
});
