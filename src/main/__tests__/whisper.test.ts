import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const vi = { fn: mock, mock: mock.module, spyOn };
import { cleanFillerWords, transcribe } from '../whisper';
import type { AppConfig } from '../../types/ipc';

const config: AppConfig = {
  whisperUrl: 'http://whisper.test/inference',
  selectedDeviceId: null,
  removeFillerWords: true,
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

  it('throws a useful error when Whisper returns a non-2xx response', async () => {
    (fetch as unknown as ReturnType<typeof mock>).mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'model unavailable',
    } as Response);

    await expect(transcribe(new Uint8Array([1]), config)).rejects.toThrow(
      'Whisper API error: 503 - model unavailable'
    );
  });

  it('returns an empty string for malformed successful responses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    (fetch as unknown as ReturnType<typeof mock>).mockResolvedValue({
      ok: true,
      json: async () => ({ result: 'missing text' }),
    } as Response);

    await expect(transcribe(new Uint8Array([1]), config)).resolves.toBe('');
    expect(warn).toHaveBeenCalledWith('Whisper response did not include text:', { result: 'missing text' });
  });
});
