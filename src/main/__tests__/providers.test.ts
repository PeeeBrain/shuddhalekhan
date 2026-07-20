import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  buildOpenAiEndpoint,
  validateOpenAiModel,
  validateOpenAiSettings,
  validateAzureSpeechSettings,
  validateCustomOpenAiSettings,
  validateProviderReadiness,
} from '../transcription';
import type { AppConfig } from '../../types/ipc';
import { installElectronMock, resetElectronMock } from '../../test/electron-mock';

const vi = { fn: mock };

installElectronMock();

function createVault(keys: Partial<Record<string, string>> = {}) {
  return { read: (id: string) => keys[id] ?? null };
}

const BASE_CONFIG: AppConfig = {
  whisperUrl: 'http://localhost:8080/inference',
  transcription: {
    activeProvider: 'openai',
    providers: {
      localWhisperCpp: { endpoint: 'http://localhost:8080/inference' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
      azureSpeech: { endpoint: '', region: '' },
      customOpenAiCompatible: { endpoint: 'http://localhost:8000/v1/audio/transcriptions', model: 'whisper-1', auth: 'none', headerName: '' },
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
    provider: { baseUrl: '', model: '', apiKeyEnvVar: '', thinkingEnabled: true },
    mcpServers: [],
  },
};

describe('OpenAI model validation', () => {
  it('accepts standard model names', () => {
    expect(validateOpenAiModel('whisper-1')).toEqual([]);
    expect(validateOpenAiModel('gpt-4o-mini-transcribe')).toEqual([]);
    expect(validateOpenAiModel('  whisper-1  ')).toEqual([]);
  });

  it('rejects empty model names', () => {
    expect(validateOpenAiModel('')).toEqual(['Enter a model name.']);
    expect(validateOpenAiModel('   ')).toEqual(['Enter a model name.']);
  });

  it('rejects model names longer than 128 characters', () => {
    expect(validateOpenAiModel('a'.repeat(129))).toEqual(['Model name is too long (max 128 characters).']);
    expect(validateOpenAiModel('a'.repeat(128))).toEqual([]);
  });

  it('accepts shell metacharacters (only control chars are forbidden)', () => {
    expect(validateOpenAiModel('whisper-1; rm -rf /')).toEqual([]);
  });
});

describe('OpenAI endpoint building', () => {
  it('appends /audio/transcriptions to a plain base URL', () => {
    expect(buildOpenAiEndpoint('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/audio/transcriptions',
    );
  });

  it('handles trailing slashes', () => {
    expect(buildOpenAiEndpoint('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1/audio/transcriptions',
    );
  });

  it('does not double-append when URL already ends with /audio/transcriptions', () => {
    expect(buildOpenAiEndpoint('https://api.openai.com/v1/audio/transcriptions')).toBe(
      'https://api.openai.com/v1/audio/transcriptions',
    );
  });
});

describe('OpenAI settings validation', () => {
  it('accepts valid OpenAI settings', () => {
    expect(validateOpenAiSettings({ baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' })).toEqual([]);
  });

  it('rejects invalid base URL', () => {
    const errors = validateOpenAiSettings({ baseUrl: 'not-a-url', model: 'whisper-1' });
    expect(errors.some((e) => e.includes('valid'))).toBe(true);
  });

  it('rejects empty model', () => {
    const errors = validateOpenAiSettings({ baseUrl: 'https://api.openai.com/v1', model: '' });
    expect(errors).toContain('Enter a model name.');
  });
});

describe('Custom OpenAI settings validation', () => {
  it('accepts valid custom settings', () => {
    expect(validateCustomOpenAiSettings({ endpoint: 'http://localhost:8000/v1/audio/transcriptions', model: 'whisper-1', auth: 'none' })).toEqual([]);
  });

  it('rejects invalid endpoint URL', () => {
    const errors = validateCustomOpenAiSettings({ endpoint: 'not-a-url', model: 'whisper-1', auth: 'none' });
    expect(errors.some((e) => e.includes('valid'))).toBe(true);
  });

  it('requires header name when auth is header', () => {
    const errors = validateCustomOpenAiSettings({ endpoint: 'http://localhost:8000/v1/audio/transcriptions', model: 'whisper-1', auth: 'header', headerName: '' });
    expect(errors).toContain('Header name is required when auth is set to Header.');
  });
});

describe('OpenAI transcriber provider', () => {
  beforeEach(() => {
    resetElectronMock();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  it('sends audio to the OpenAI endpoint with Bearer auth', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'transcribed from openai' }),
    } as Response);

    const { getTranscriber } = await import('../providers');
    const vault = createVault({ 'openai-api-key': 'sk-test-key-12345' });
    const transcriber = getTranscriber(BASE_CONFIG, vault);

    const result = await transcriber.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    });

    expect(result).toBe('transcribed from openai');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test-key-12345',
        }),
      }),
    );
  });

  it('throws authentication failure when no API key is saved', async () => {
    const { getTranscriber } = await import('../providers');
    const vault = createVault({});

    const transcriber = getTranscriber(BASE_CONFIG, vault);

    await expect(transcriber.transcribe({
      audio: new Uint8Array([1]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    })).rejects.toMatchObject({
      category: 'authentication',
      message: expect.stringContaining('API key'),
    });
  });

  it('normalizes HTTP failures without exposing response material', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'api_key=super-secret',
    } as Response);

    const { getTranscriber } = await import('../providers');
    const vault = createVault({ 'openai-api-key': 'sk-test-key' });
    const transcriber = getTranscriber(BASE_CONFIG, vault);

    const error = await transcriber.transcribe({
      audio: new Uint8Array([1]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    }).catch((e) => e);

    expect(error).toMatchObject({ category: 'authentication', status: 401 });
    expect(error.message).not.toContain('super-secret');
  });

  it('sends the model parameter in the form', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'test' }),
    } as Response);

    const { getTranscriber } = await import('../providers');
    const vault = createVault({ 'openai-api-key': 'sk-test-key' });
    const transcriber = getTranscriber(BASE_CONFIG, vault);

    await transcriber.transcribe({
      audio: new Uint8Array([1]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    });

    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get('model')).toBe('whisper-1');
  });

  it('applies language and uses /audio/translations for translation task', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'translated' }),
    } as Response);

    const { getTranscriber } = await import('../providers');
    const vault = createVault({ 'openai-api-key': 'sk-test-key' });
    const transcriber = getTranscriber(BASE_CONFIG, vault);

    await transcriber.transcribe({
      audio: new Uint8Array([1]),
      recognition: { language: 'mr', task: 'translate', dictionary: [], removeFillerWords: false },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/translations',
      expect.anything(),
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get('language')).toBe('en');
  });
});

describe('Custom OpenAI transcriber provider', () => {
  beforeEach(() => {
    resetElectronMock();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  it('sends audio to the configured endpoint without auth and sends model', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'custom transcription' }),
    } as Response);

    const { getTranscriber } = await import('../providers');
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: {
        activeProvider: 'custom-open-ai-compatible',
        providers: {
          ...BASE_CONFIG.transcription.providers,
          customOpenAiCompatible: { endpoint: 'http://localhost:8000/v1/audio/transcriptions', model: 'whisper-1', auth: 'none', headerName: '' },
        },
      },
    };
    const vault = createVault({});
    const transcriber = getTranscriber(config, vault);

    const result = await transcriber.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    });

    expect(result).toBe('custom transcription');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: {},
      }),
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get('model')).toBe('whisper-1');
    expect(body.has('temperature')).toBe(false);
  });

  it('uses Bearer auth when configured', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'bearer auth' }),
    } as Response);

    const { getTranscriber } = await import('../providers');
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: {
        activeProvider: 'custom-open-ai-compatible',
        providers: {
          ...BASE_CONFIG.transcription.providers,
          customOpenAiCompatible: { endpoint: 'http://localhost:8000/v1/audio/transcriptions', model: 'whisper-1', auth: 'bearer', headerName: '' },
        },
      },
    };
    const vault = createVault({ 'custom-open-ai-compatible-bearer': 'my-bearer-token' });
    const transcriber = getTranscriber(config, vault);

    await transcriber.transcribe({
      audio: new Uint8Array([1]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer my-bearer-token' }),
      }),
    );
  });

  it('uses custom header auth when configured', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'header auth' }),
    } as Response);

    const { getTranscriber } = await import('../providers');
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: {
        activeProvider: 'custom-open-ai-compatible',
        providers: {
          ...BASE_CONFIG.transcription.providers,
          customOpenAiCompatible: { endpoint: 'http://localhost:8000/v1/audio/transcriptions', model: 'whisper-1', auth: 'header', headerName: 'X-API-Key' },
        },
      },
    };
    const vault = createVault({ 'custom-open-ai-compatible-header': 'secret-value' });
    const transcriber = getTranscriber(config, vault);

    await transcriber.transcribe({
      audio: new Uint8Array([1]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-API-Key': 'secret-value' }),
      }),
    );
  });

  it('throws authentication failure when bearer token is missing', async () => {
    const { getTranscriber } = await import('../providers');
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: {
        activeProvider: 'custom-open-ai-compatible',
        providers: {
          ...BASE_CONFIG.transcription.providers,
          customOpenAiCompatible: { endpoint: 'http://localhost:8000/v1/audio/transcriptions', model: 'whisper-1', auth: 'bearer', headerName: '' },
        },
      },
    };
    const vault = createVault({});
    const transcriber = getTranscriber(config, vault);

    await expect(transcriber.transcribe({
      audio: new Uint8Array([1]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    })).rejects.toMatchObject({ category: 'authentication' });
  });

  it('throws endpoint failure when no endpoint configured', async () => {
    const { getTranscriber } = await import('../providers');
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: {
        activeProvider: 'custom-open-ai-compatible',
        providers: {
          ...BASE_CONFIG.transcription.providers,
          customOpenAiCompatible: { endpoint: '', model: 'whisper-1', auth: 'none', headerName: '' },
        },
      },
    };
    const vault = createVault({});
    const transcriber = getTranscriber(config, vault);

    await expect(transcriber.transcribe({
      audio: new Uint8Array([1]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    })).rejects.toMatchObject({ category: 'endpoint' });
  });
});

describe('Microsoft Azure Speech provider', () => {
  beforeEach(() => {
    resetElectronMock();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  function azureConfig(overrides: Partial<AppConfig['transcription']['providers']['azureSpeech']> = {}): AppConfig {
    return {
      ...BASE_CONFIG,
      language: 'en',
      transcription: {
        activeProvider: 'azure-speech',
        providers: {
          ...BASE_CONFIG.transcription.providers,
          azureSpeech: {
            endpoint: 'https://speech-resource.cognitiveservices.azure.com',
            region: '',
            ...overrides,
          },
        },
      },
    };
  }

  it('uses the synchronous Fast Transcription request contract with key auth', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ combinedPhrases: [{ text: 'Azure transcript' }], phrases: [] }),
    } as Response);
    const { getTranscriber } = await import('../providers');
    const transcriber = getTranscriber(azureConfig(), createVault({ 'azure-speech-key': 'azure-secret' }));

    await expect(transcriber.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      recognition: {
        language: 'hi',
        task: 'transcribe',
        dictionary: ['Shuddhalekhan', 'Contoso'],
        removeFillerWords: false,
      },
    })).resolves.toBe('Azure transcript');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://speech-resource.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': 'azure-secret' },
      }),
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get('audio')).toBeInstanceOf(Blob);
    expect(JSON.parse(String(body.get('definition')))).toEqual({
      locales: ['hi-IN'],
      phraseList: { phrases: ['Shuddhalekhan', 'Contoso'] },
    });
    expect(body.has('model')).toBe(false);
  });

  it('constructs a regional endpoint and omits locales for automatic detection', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ combinedPhrases: [{ text: 'Detected speech' }] }),
    } as Response);
    const { getTranscriber } = await import('../providers');
    const transcriber = getTranscriber(
      azureConfig({ endpoint: '', region: 'CentralIndia' }),
      createVault({ 'azure-speech-key': 'key' }),
    );

    await transcriber.transcribe({
      audio: new Uint8Array([1]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://centralindia.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15',
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(JSON.parse(String(body.get('definition')))).toEqual({});
  });

  it('rejects translation locally without making a request', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const { getTranscriber } = await import('../providers');
    const transcriber = getTranscriber(azureConfig(), createVault({ 'azure-speech-key': 'key' }));

    await expect(transcriber.transcribe({
      audio: new Uint8Array([1]),
      recognition: { language: 'en', task: 'translate', dictionary: [], removeFillerWords: false },
    })).rejects.toMatchObject({ category: 'model', message: expect.stringContaining('not supported') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes authentication, quota, endpoint, malformed response, and network failures', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const { getTranscriber } = await import('../providers');
    const transcriber = getTranscriber(azureConfig(), createVault({ 'azure-speech-key': 'key' }));
    const request = {
      audio: new Uint8Array([1]),
      recognition: { language: 'en', task: 'transcribe' as const, dictionary: [], removeFillerWords: false },
    };

    for (const [status, category] of [[401, 'authentication'], [429, 'rate-limit'], [404, 'endpoint']] as const) {
      fetchMock.mockResolvedValueOnce({ ok: false, status } as Response);
      await expect(transcriber.transcribe(request)).rejects.toMatchObject({ category, status });
    }
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ unexpected: 'secret' }) } as Response);
    await expect(transcriber.transcribe(request)).rejects.toMatchObject({ category: 'malformed-response' });
    fetchMock.mockRejectedValueOnce(new Error('network includes secret'));
    await expect(transcriber.transcribe(request)).rejects.toMatchObject({
      category: 'network',
      message: expect.not.stringContaining('secret'),
    });
  });

  it('validates provider-native fields and saved credentials locally', () => {
    expect(validateAzureSpeechSettings({ endpoint: '', region: '' })).toEqual([
      'Enter a Microsoft Azure Speech resource endpoint or region.',
    ]);
    expect(validateAzureSpeechSettings({ endpoint: 'http://unsafe.test', region: '' })).toEqual([
      'Azure resource endpoint must use HTTPS.',
    ]);
    expect(validateAzureSpeechSettings({ endpoint: '', region: 'centralindia' })).toEqual([]);

    const missingKey = validateProviderReadiness('azure-speech', azureConfig(), createVault());
    expect(missingKey).toContain('Microsoft Azure Speech key is not configured. Save one in Settings.');
    expect(validateProviderReadiness(
      'azure-speech',
      azureConfig(),
      createVault({ 'azure-speech-key': 'key' }),
    )).toEqual([]);
  });

  it('declares Fast Transcription capabilities', async () => {
    const { AZURE_SPEECH_CAPABILITIES } = await import('../azure-speech');
    expect(AZURE_SPEECH_CAPABILITIES).toEqual({
      translation: false,
      automaticLanguageDetection: true,
      dictionaryHints: true,
      authentication: 'required',
      maxDurationSeconds: null,
    });
  });
});

describe('getTranscriber provider selection', () => {
  it('returns the local whisper transcriber for local-whisper-cpp', async () => {
    const { getTranscriber } = await import('../providers');
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: { ...BASE_CONFIG.transcription, activeProvider: 'local-whisper-cpp' },
    };
    const vault = createVault({});

    const transcriber = getTranscriber(config, vault);
    expect(transcriber.id).toBe('local-whisper-cpp');
  });

  it('returns the OpenAI transcriber for openai', async () => {
    const { getTranscriber } = await import('../providers');
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: { ...BASE_CONFIG.transcription, activeProvider: 'openai' },
    };
    const vault = createVault({ 'openai-api-key': 'sk-key' });

    const transcriber = getTranscriber(config, vault);
    expect(transcriber.id).toBe('openai');
  });

  it('returns the Microsoft Azure Speech transcriber for azure-speech', async () => {
    const { getTranscriber } = await import('../providers');
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: { ...BASE_CONFIG.transcription, activeProvider: 'azure-speech' },
    };
    expect(getTranscriber(config, createVault({})).id).toBe('azure-speech');
  });

  it('returns the custom OpenAI transcriber for custom-open-ai-compatible', async () => {
    const { getTranscriber } = await import('../providers');
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: { ...BASE_CONFIG.transcription, activeProvider: 'custom-open-ai-compatible' },
    };
    const vault = createVault({});

    const transcriber = getTranscriber(config, vault);
    expect(transcriber.id).toBe('custom-open-ai-compatible');
  });
});

describe('provider capabilities', () => {
  it('describes the OpenAI transcription contract', async () => {
    const { OPENAI_CAPABILITIES } = await import('../providers');
    expect(OPENAI_CAPABILITIES).toEqual({
      translation: true,
      automaticLanguageDetection: true,
      dictionaryHints: true,
      authentication: 'required',
      maxDurationSeconds: null,
    });
  });

  it('describes the custom OpenAI transcription contract', async () => {
    const { CUSTOM_OPENAI_CAPABILITIES } = await import('../providers');
    expect(CUSTOM_OPENAI_CAPABILITIES).toEqual({
      translation: true,
      automaticLanguageDetection: true,
      dictionaryHints: true,
      authentication: 'optional',
      maxDurationSeconds: null,
    });
  });

  it('validates recording readiness for local whisper', () => {
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: { ...BASE_CONFIG.transcription, activeProvider: 'local-whisper-cpp' },
    };
    expect(validateProviderReadiness('local-whisper-cpp', config, { read: () => null })).toEqual([]);
  });

  it('returns errors when local endpoint is empty', () => {
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: {
        activeProvider: 'local-whisper-cpp',
        providers: {
          ...BASE_CONFIG.transcription.providers,
          localWhisperCpp: { endpoint: '' },
        },
      },
    };
    const errors = validateProviderReadiness('local-whisper-cpp', config, { read: () => null });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/endpoint/i);
  });

  it('returns errors when OpenAI model is empty', () => {
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: {
        activeProvider: 'openai',
        providers: {
          ...BASE_CONFIG.transcription.providers,
          openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
        },
      },
    };
    const errors = validateProviderReadiness('openai', config, { read: () => null });
    expect(errors.some((e) => e.includes('model'))).toBe(true);
  });

  it('returns errors when OpenAI API key is missing', () => {
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: { ...BASE_CONFIG.transcription, activeProvider: 'openai' },
    };
    const errors = validateProviderReadiness('openai', config, { read: () => null });
    expect(errors.some((e) => e.includes('API key'))).toBe(true);
  });

  it('returns no errors when OpenAI is fully configured', () => {
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: { ...BASE_CONFIG.transcription, activeProvider: 'openai' },
    };
    const errors = validateProviderReadiness('openai', config, { read: (id) => id === 'openai-api-key' ? 'sk-key' : null });
    expect(errors).toEqual([]);
  });

  it('returns errors when custom provider has no model', () => {
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: {
        activeProvider: 'custom-open-ai-compatible',
        providers: {
          ...BASE_CONFIG.transcription.providers,
          customOpenAiCompatible: { endpoint: 'http://localhost:8000/v1/audio/transcriptions', model: '', auth: 'none', headerName: '' },
        },
      },
    };
    const errors = validateProviderReadiness('custom-open-ai-compatible', config, { read: () => null });
    expect(errors.some((e) => e.includes('model'))).toBe(true);
  });

  it('returns errors for custom bearer auth when token is missing', () => {
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: {
        activeProvider: 'custom-open-ai-compatible',
        providers: {
          ...BASE_CONFIG.transcription.providers,
          customOpenAiCompatible: { endpoint: 'http://localhost:8000/v1/audio/transcriptions', model: 'whisper-1', auth: 'bearer', headerName: '' },
        },
      },
    };
    const errors = validateProviderReadiness('custom-open-ai-compatible', config, { read: () => null });
    expect(errors.some((e) => e.includes('token'))).toBe(true);
  });

  it('returns errors for custom header auth when header name is invalid', () => {
    const config: AppConfig = {
      ...BASE_CONFIG,
      transcription: {
        activeProvider: 'custom-open-ai-compatible',
        providers: {
          ...BASE_CONFIG.transcription.providers,
          customOpenAiCompatible: { endpoint: 'http://localhost:8000/v1/audio/transcriptions', model: 'whisper-1', auth: 'header', headerName: 'bad\nheader' },
        },
      },
    };
    const errors = validateProviderReadiness('custom-open-ai-compatible', config, { read: (_id) => 'secret' });
    expect(errors.some((e) => e.includes('Header name'))).toBe(true);
  });
});
