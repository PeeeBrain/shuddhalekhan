import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { normalize } from 'path';
import { installElectronMock, resetElectronMock } from '../../test/electron-mock';

const vi = { fn: mock, mock: mock.module, spyOn };

const storeData = new Map<string, unknown>();
const existsSync = vi.fn();
const readFileSync = vi.fn();
const unlinkSync = vi.fn();

class MockStore {
  constructor(options: { defaults: Record<string, unknown> }) {
    for (const [key, value] of Object.entries(options.defaults)) {
      if (!storeData.has(key)) storeData.set(key, value);
    }
  }

  get(key: string) {
    return storeData.get(key);
  }

  set(key: string, value: unknown) {
    storeData.set(key, value);
  }
}

mock.module('electron-store', () => ({ default: MockStore }));
installElectronMock();
mock.module('fs', () => ({
  existsSync,
  readFileSync,
  unlinkSync,
}));

describe('config store', () => {
  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    storeData.clear();
    resetElectronMock();
    existsSync.mockReset();
    readFileSync.mockReset();
    unlinkSync.mockReset();
  });

  it('returns defaults when no legacy config exists', async () => {
    existsSync.mockReturnValue(false);
    const { getConfig } = await import(`../config?test=${Date.now()}-1`);

    expect(getConfig().transcription).toEqual({
      activeProvider: 'local-whisper-cpp',
      providers: {
        localWhisperCpp: { endpoint: 'http://localhost:8080/inference' },
        openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
        azureSpeech: { endpoint: '', region: '' },
        googleCloudSpeech: { project: '', location: 'global', model: '', credentialSource: 'service-account' },
        nvidiaSpeechNim: { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
        customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
      },
    });
    expect(getConfig()).toMatchObject({
      whisperUrl: 'http://localhost:8080/inference',
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
    });
  });

  it('defaults recording activation to push-to-talk', async () => {
    existsSync.mockReturnValue(false);
    const { getConfig } = await import(`../config?test=${Date.now()}-activation-default`);

    expect(getConfig().recordingActivationMode).toBe('push-to-talk');
  });

  it('falls back to push-to-talk for an invalid stored activation mode', async () => {
    existsSync.mockReturnValue(false);
    const { getConfig } = await import(`../config?test=${Date.now()}-activation-invalid`);
    storeData.set('recordingActivationMode', 'unsupported');

    expect(getConfig().recordingActivationMode).toBe('push-to-talk');
  });

  it('sets typed config values', async () => {
    existsSync.mockReturnValue(false);
    const { getConfig, setConfig } = await import(`../config?test=${Date.now()}-2`);

    setConfig('selectedDeviceId', 'usb-mic');
    setConfig('removeFillerWords', false);

    expect(getConfig()).toMatchObject({
      whisperUrl: 'http://localhost:8080/inference',
      selectedDeviceId: 'usb-mic',
      removeFillerWords: false,
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
    });
  });

  it('migrates an existing whisperUrl into the active local provider without setup', async () => {
    existsSync.mockReturnValue(false);
    storeData.set('whisperUrl', 'http://existing.test/inference');

    const { getConfig } = await import(`../config?test=${Date.now()}-provider-migration`);

    expect(getConfig().transcription).toEqual({
      activeProvider: 'local-whisper-cpp',
      providers: {
        localWhisperCpp: { endpoint: 'http://existing.test/inference' },
        openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
        azureSpeech: { endpoint: '', region: '' },
        googleCloudSpeech: { project: '', location: 'global', model: '', credentialSource: 'service-account' },
        nvidiaSpeechNim: { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
        customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
      },
    });
  });

  it('retains local provider settings in the provider-specific configuration', async () => {
    existsSync.mockReturnValue(false);
    const { getConfig, setConfig } = await import(`../config?test=${Date.now()}-provider-retention`);

    setConfig('transcription', {
      activeProvider: 'local-whisper-cpp',
      providers: {
        localWhisperCpp: { endpoint: 'https://private.test/inference' },
        openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
        azureSpeech: { endpoint: '', region: '' },
        googleCloudSpeech: { project: '', location: 'global', model: '', credentialSource: 'service-account' },
        nvidiaSpeechNim: { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
        customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
      },
    });

    expect(getConfig().transcription.providers.localWhisperCpp.endpoint).toBe(
      'https://private.test/inference',
    );
  });

  it('retains inactive Microsoft Azure Speech configuration', async () => {
    existsSync.mockReturnValue(false);
    const { getConfig, setConfig } = await import(`../config?test=${Date.now()}-azure-retention`);
    const transcription = getConfig().transcription;

    setConfig('transcription', {
      ...transcription,
      activeProvider: 'azure-speech',
      providers: {
        ...transcription.providers,
        azureSpeech: {
          endpoint: 'https://speech-resource.cognitiveservices.azure.com',
          region: 'centralindia',
        },
      },
    });
    setConfig('transcription', {
      ...getConfig().transcription,
      activeProvider: 'local-whisper-cpp',
    });

    expect(getConfig().transcription.providers.azureSpeech).toEqual({
      endpoint: 'https://speech-resource.cognitiveservices.azure.com',
      region: 'centralindia',
    });
  });

  it('migrates and deletes the legacy config once', async () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({
      whisper_url: 'http://legacy.test/inference',
      selected_device: 'legacy-mic',
      remove_filler_words: false,
    }));

    const { getConfig } = await import(`../config?test=${Date.now()}-3`);

    expect(getConfig()).toMatchObject({
      whisperUrl: 'http://legacy.test/inference',
      selectedDeviceId: 'legacy-mic',
      removeFillerWords: false,
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
    });
    expect(readFileSync).toHaveBeenCalledWith(normalize('/home/tester/.speech-2-text/config.json'), 'utf-8');
    expect(unlinkSync).toHaveBeenCalledWith(normalize('/home/tester/.speech-2-text/config.json'));
  });

  it('ignores malformed legacy config and keeps defaults', async () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue('{bad json');

    const { getConfig } = await import(`../config?test=${Date.now()}-4`);

    expect(getConfig()).toMatchObject({
      whisperUrl: 'http://localhost:8080/inference',
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
    });
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it('defaults newly discovered MCP tools to alwaysAsk for generic MCP servers', async () => {
    existsSync.mockReturnValue(false);
    const { getConfig, setConfig } = await import(`../config?test=${Date.now()}-5`);

    setConfig('agent', {
      enabled: true,
      provider: {
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openai/gpt-4.1-mini',
        apiKeyEnvVar: 'OPENROUTER_API_KEY',
        thinkingEnabled: false,
      },
      mcpServers: [
        {
          id: 'mail-primary',
          displayName: 'Hosted Mail',
          enabled: true,
          transport: {
            type: 'http',
            url: 'https://mail.example.com/mcp',
          },
          discoveredTools: [
            {
              name: 'draft_email',
              description: 'Draft an email',
              discoveredAt: '2026-05-07T00:00:00.000Z',
            },
          ],
          toolPolicies: {},
        },
        {
          id: 'mail-secondary',
          displayName: 'Hosted Mail Second Account',
          enabled: true,
          transport: {
            type: 'http',
            url: 'https://mail2.example.com/mcp',
          },
          discoveredTools: [],
          toolPolicies: {},
        },
      ],
    });

    expect(getConfig().agent.mcpServers).toEqual([
      {
        id: 'mail-primary',
        displayName: 'Hosted Mail',
        enabled: true,
        transport: {
          type: 'http',
          url: 'https://mail.example.com/mcp',
          redirect: 'error',
        },
        discoveredTools: [
          {
            name: 'draft_email',
            description: 'Draft an email',
            discoveredAt: '2026-05-07T00:00:00.000Z',
          },
        ],
        toolPolicies: {
          'mail-primary:draft_email': 'alwaysAsk',
        },
      },
      {
        id: 'mail-secondary',
        displayName: 'Hosted Mail Second Account',
        enabled: true,
        transport: {
          type: 'http',
          url: 'https://mail2.example.com/mcp',
          redirect: 'error',
        },
        discoveredTools: [],
        toolPolicies: {},
      },
    ]);
    expect(getConfig().agent.provider.thinkingEnabled).toBe(false);
  });

  it('merges discovered tools and injects default policies in the config store', async () => {
    existsSync.mockReturnValue(false);
    const { getConfig, setConfig, mergeDiscoveredTools } = await import(`../config?test=${Date.now()}-merge-tools`);

    setConfig('agent', {
      enabled: true,
      provider: {
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openai/gpt-4.1-mini',
        apiKeyEnvVar: 'OPENROUTER_API_KEY',
        thinkingEnabled: false,
      },
      mcpServers: [
        {
          id: 'mail',
          displayName: 'Hosted Mail',
          enabled: true,
          transport: { type: 'http', url: 'https://mail.example.com/mcp' },
          discoveredTools: [],
          toolPolicies: { 'mail:read_email': 'alwaysAllow' },
        },
      ],
    });

    mergeDiscoveredTools('mail', [
      { name: 'read_email', description: 'Read messages' },
      { name: 'send_email', description: 'Send messages', inputSchema: { type: 'object' } },
    ]);

    expect(getConfig().agent.mcpServers[0]).toEqual(expect.objectContaining({
      discoveredTools: [
        expect.objectContaining({ name: 'read_email', description: 'Read messages', discoveredAt: expect.any(String) }),
        expect.objectContaining({ name: 'send_email', description: 'Send messages', inputSchema: { type: 'object' }, discoveredAt: expect.any(String) }),
      ],
      toolPolicies: {
        'mail:read_email': 'alwaysAllow',
        'mail:send_email': 'alwaysAsk',
      },
    }));
  });

  it('defaults missing provider thinking toggle to enabled', async () => {
    existsSync.mockReturnValue(false);
    const { getConfig, setConfig } = await import(`../config?test=${Date.now()}-thinking-default`);

    setConfig('agent', {
      enabled: true,
      provider: {
        baseUrl: 'http://localhost:1234/v1',
        model: 'local-model',
        apiKeyEnvVar: '',
      },
      mcpServers: [],
    } as never);

    expect(getConfig().agent.provider.thinkingEnabled).toBe(true);
  });
});
