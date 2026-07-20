import Store from 'electron-store';
import { app } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import type { AppConfig, McpDiscoveredTool, TranscriptionConfig } from '../types/ipc';
import { normalizeMcpServers } from '../agent/mcp-server-config';

type StoreConfig = AppConfig & {
  migrated?: boolean;
  transcriptionMigrated?: boolean;
};

const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:8080/inference';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = '';
const DEFAULT_TRANSCRIPTION: TranscriptionConfig = {
  activeProvider: 'local-whisper-cpp',
  providers: {
    localWhisperCpp: { endpoint: DEFAULT_LOCAL_ENDPOINT },
    openai: { baseUrl: DEFAULT_OPENAI_BASE_URL, model: DEFAULT_OPENAI_MODEL },
    azureSpeech: { endpoint: '', region: '' },
    googleCloudSpeech: { project: '', location: 'global', model: '', credentialSource: 'service-account' },
    nvidiaSpeechNim: { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
    customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
  },
};

const store = new Store<StoreConfig>({
  name: 'shuddhalekhan-config',
  defaults: {
    whisperUrl: DEFAULT_LOCAL_ENDPOINT,
    transcription: DEFAULT_TRANSCRIPTION,
    selectedDeviceId: null,
    removeFillerWords: true,
    language: 'auto',
    task: 'transcribe',
    dictionary: [],
    pasteStrategy: {
      default: 'ctrl-v',
      overrides: {},
    },
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
  },
});

// Migrate old config from ~/.speech-2-text/config.json on first run
function maybeMigrateLegacyConfig(): void {
  const legacyDir = join(app.getPath('home'), '.speech-2-text');
  const legacyPath = join(legacyDir, 'config.json');

  if (existsSync(legacyPath) && !store.get('migrated')) {
    try {
      const raw = readFileSync(legacyPath, 'utf-8');
      const legacy = JSON.parse(raw);

      if (legacy.whisper_url) store.set('whisperUrl', legacy.whisper_url);
      if (legacy.selected_device) store.set('selectedDeviceId', legacy.selected_device);
      if (typeof legacy.remove_filler_words === 'boolean') {
        store.set('removeFillerWords', legacy.remove_filler_words);
      }

      store.set('migrated', true);
      // Clean up legacy file
      try {
        unlinkSync(legacyPath);
      } catch {
        // ignore cleanup failure
      }
    } catch {
      // ignore malformed legacy config
    }
  }
}

maybeMigrateLegacyConfig();

function maybeMigrateTranscriptionConfig(): void {
  if (store.get('transcriptionMigrated')) return;

  const legacyEndpoint = store.get('whisperUrl') || DEFAULT_LOCAL_ENDPOINT;
  const transcription = store.get('transcription');
  const currentEndpoint = transcription?.providers?.localWhisperCpp?.endpoint;
  const endpoint = currentEndpoint && currentEndpoint !== DEFAULT_LOCAL_ENDPOINT
    ? currentEndpoint
    : legacyEndpoint;

  store.set('transcription', {
    activeProvider: 'local-whisper-cpp',
    providers: {
      localWhisperCpp: { endpoint },
      openai: transcription?.providers?.openai ?? { baseUrl: DEFAULT_OPENAI_BASE_URL, model: DEFAULT_OPENAI_MODEL },
      azureSpeech: transcription?.providers?.azureSpeech ?? { endpoint: '', region: '' },
      googleCloudSpeech: transcription?.providers?.googleCloudSpeech ?? { project: '', location: 'global', model: '', credentialSource: 'service-account' },
      nvidiaSpeechNim: transcription?.providers?.nvidiaSpeechNim ?? { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
      customOpenAiCompatible: transcription?.providers?.customOpenAiCompatible ?? { endpoint: '', model: '', auth: 'none', headerName: '' },
    },
  });
  store.set('transcriptionMigrated', true);
}

maybeMigrateTranscriptionConfig();

export function getConfig(): AppConfig {
  const agent = store.get('agent');
  const mcpServers = normalizeMcpServers(agent?.mcpServers);
  const recordingActivationMode = store.get('recordingActivationMode') === 'toggle'
    ? 'toggle'
    : 'push-to-talk';

  const storedTranscription = store.get('transcription');
  const localEndpoint = storedTranscription?.providers?.localWhisperCpp?.endpoint
    || store.get('whisperUrl')
    || DEFAULT_LOCAL_ENDPOINT;
  const transcription: TranscriptionConfig = {
    activeProvider: storedTranscription?.activeProvider ?? 'local-whisper-cpp',
    providers: {
      localWhisperCpp: { endpoint: localEndpoint },
      openai: storedTranscription?.providers?.openai ?? { baseUrl: DEFAULT_OPENAI_BASE_URL, model: DEFAULT_OPENAI_MODEL },
      azureSpeech: storedTranscription?.providers?.azureSpeech ?? { endpoint: '', region: '' },
      googleCloudSpeech: storedTranscription?.providers?.googleCloudSpeech ?? { project: '', location: 'global', model: '', credentialSource: 'service-account' },
      nvidiaSpeechNim: storedTranscription?.providers?.nvidiaSpeechNim ?? { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
      customOpenAiCompatible: storedTranscription?.providers?.customOpenAiCompatible ?? { endpoint: '', model: '', auth: 'none', headerName: '' },
    },
  };

  return {
    whisperUrl: localEndpoint,
    transcription,
    selectedDeviceId: store.get('selectedDeviceId'),
    removeFillerWords: store.get('removeFillerWords'),
    language: store.get('language') ?? 'auto',
    task: store.get('task') ?? 'transcribe',
    dictionary: store.get('dictionary') ?? [],
    pasteStrategy: store.get('pasteStrategy') ?? { default: 'ctrl-v', overrides: {} },
    setupChecklistDismissed: store.get('setupChecklistDismissed') ?? false,
    recordingActivationMode,
    agent: {
      enabled: agent?.enabled ?? false,
      provider: {
        baseUrl: agent?.provider?.baseUrl ?? '',
        model: agent?.provider?.model ?? '',
        apiKeyEnvVar: agent?.provider?.apiKeyEnvVar ?? '',
        thinkingEnabled: agent?.provider?.thinkingEnabled ?? true,
      },
      mcpServers,
    },
  };
}

export function setConfig<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
  store.set(key, value);
  if (key === 'transcription') {
    store.set('whisperUrl', (value as TranscriptionConfig).providers.localWhisperCpp.endpoint);
  } else if (key === 'whisperUrl') {
    // Preserve existing cloud provider configs; only update local
    const existing = store.get('transcription');
    store.set('transcription', {
      activeProvider: existing?.activeProvider ?? 'local-whisper-cpp',
      providers: {
        localWhisperCpp: { endpoint: value as string },
        openai: existing?.providers?.openai ?? { baseUrl: DEFAULT_OPENAI_BASE_URL, model: DEFAULT_OPENAI_MODEL },
        azureSpeech: existing?.providers?.azureSpeech ?? { endpoint: '', region: '' },
        googleCloudSpeech: existing?.providers?.googleCloudSpeech ?? { project: '', location: 'global', model: '', credentialSource: 'service-account' },
        nvidiaSpeechNim: existing?.providers?.nvidiaSpeechNim ?? { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
        customOpenAiCompatible: existing?.providers?.customOpenAiCompatible ?? { endpoint: '', model: '', auth: 'none', headerName: '' },
      },
    });
  }
}

export function mergeDiscoveredTools(
  serverId: string,
  tools: Array<{ name: string; description: string; inputSchema?: unknown }>
): void {
  const config = getConfig();
  const discoveredAt = new Date().toISOString();
  const mcpServers = config.agent.mcpServers.map((server) => {
    if (server.id !== serverId) return server;

    const discoveredTools: McpDiscoveredTool[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      discoveredAt,
    }));
    const toolPolicies = { ...server.toolPolicies };
    for (const tool of discoveredTools) {
      const key = `${server.id}:${tool.name}` as const;
      if (!toolPolicies[key]) toolPolicies[key] = 'alwaysAsk';
    }

    return {
      ...server,
      discoveredTools,
      toolPolicies,
    };
  });

  store.set('agent', {
    ...config.agent,
    mcpServers,
  });
}
