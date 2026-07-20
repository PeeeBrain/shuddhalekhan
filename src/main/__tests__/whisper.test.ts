import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const vi = { fn: mock, mock: mock.module, spyOn };
import { cleanFillerWords, transcribe } from '../whisper';
import { TranscriptionFailure } from '../transcription';
import type { AppConfig } from '../../types/ipc';

const config: AppConfig = {
  whisperUrl: 'http://whisper.test/inference',
  transcription: {
    activeProvider: 'local-whisper-cpp',
    providers: {
      localWhisperCpp: { endpoint: 'http://whisper.test/inference' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
      azureSpeech: { endpoint: '', region: '' },
      customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
    },
  },
  selectedDeviceId: null,
  removeFillerWords: true,
  language: 'auto',
  task: 'transcribe',
  dictionary: [],
  pasteStrategy: { default: 'ctrl-v', overrides: {} },
  setupChecklistDismissed: false,
  recordingActivationMode: 'push-to-talk',
  agent: {
    enabled: false,
    provider: {
      baseUrl: '',
      model: '',
      apiKeyEnvVar: '',
      thinkingEnabled: true,
    },
    mcpServers: [],
  },
};

describe('cleanFillerWords', () => {
  it('removes common filler words and repairs spacing around punctuation', () => {
    expect(cleanFillerWords('Um, this is uh a test ah. Done !')).toBe('this is a test. Done!');
  });

  it('does not remove filler substrings from real words', () => {
    expect(cleanFillerWords('The museum has thermal equipment.')).toBe('The museum has thermal equipment.');
  });
});

describe('transcribe', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  it('posts WAV audio to the configured Whisper endpoint', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: ' hello world ' }),
    } as Response);

    await expect(transcribe(new Uint8Array([1, 2, 3]), config)).resolves.toBe('hello world');

    expect(fetchMock).toHaveBeenCalledWith(config.whisperUrl, {
      method: 'POST',
      body: expect.any(FormData) as BodyInit,
    });
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get('temperature')).toBe('0.2');
    expect(body.get('response_format')).toBe('json');
    expect(body.get('prompt')).toBeTypeOf('string');
  });

  it('omits the cleanup prompt and preserves text when cleanup is disabled', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'um keep exact wording' }),
    } as Response);

    const text = await transcribe(new Uint8Array([1]), {
      ...config,
      removeFillerWords: false,
    });

    expect(text).toBe('um keep exact wording');
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.has('prompt')).toBe(false);
  });

  it('normalizes HTTP failures without exposing response material', async () => {
    (fetch as unknown as ReturnType<typeof mock>).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'api_key=super-secret',
    } as Response);

    const rejection = transcribe(new Uint8Array([1]), config).catch((error) => error);
    await expect(rejection).resolves.toEqual(expect.objectContaining({
      name: 'TranscriptionFailure',
      category: 'authentication',
      status: 401,
      message: 'The transcription provider rejected authentication.',
    }));
    expect((await rejection).message).not.toContain('super-secret');
  });

  it('normalizes network, rate-limit, endpoint, model, and unknown failures', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED token=secret'));
    await expect(transcribe(new Uint8Array([1]), config)).rejects.toMatchObject({ category: 'network' });

    for (const [status, category] of [[429, 'rate-limit'], [404, 'endpoint'], [422, 'model'], [503, 'unknown']] as const) {
      fetchMock.mockResolvedValueOnce({ ok: false, status, text: async () => 'sensitive body' } as Response);
      await expect(transcribe(new Uint8Array([1]), config)).rejects.toMatchObject({ category });
    }
  });

  it('rejects malformed successful responses with a normalized failure', async () => {
    (fetch as unknown as ReturnType<typeof mock>).mockResolvedValue({
      ok: true,
      json: async () => ({ result: 'missing text', secret: 'do-not-log' }),
    } as Response);

    await expect(transcribe(new Uint8Array([1]), config)).rejects.toEqual(
      new TranscriptionFailure('malformed-response', 'The transcription provider returned an invalid response.'),
    );
  });

  it('appends language and whisper.cpp translate form fields when configured', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'translated text' }),
    } as Response);

    await transcribe(new Uint8Array([1]), { ...config, language: 'mr', task: 'translate' });

    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get('language')).toBe('mr');
    expect(body.get('translate')).toBe('true');
    expect(body.has('task')).toBe(false);
  });

  it('omits auto language and explicitly disables translation by default', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof mock>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'hello' }),
    } as Response);

    await transcribe(new Uint8Array([1]), config);

    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.has('language')).toBe(false);
    expect(body.get('translate')).toBe('false');
    expect(body.has('task')).toBe(false);
  });
});
