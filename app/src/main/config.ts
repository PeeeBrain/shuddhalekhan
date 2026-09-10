import Store from 'electron-store';
import { app } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import type { AppConfig, DictationConfig, IntentShortcutConfig, McpDiscoveredTool, ShortcutsConfig, TranscriptionConfig, TranscriptionProviderId } from '../types/ipc';
import { normalizeMcpServers } from '../agent/mcp-server-config';
import { assessBinding, DEFAULT_SHORTCUTS, normalizeBinding } from '../shared/shortcut-bindings';
import { getDictationCombinationError, getTranscriptionTransportCapabilities, normalizeDictationConfig, resolveInstallDefaults } from '../shared/dictation-runtime';
import { preparePersistentStoreDirectory } from './store-path';
import { isolatePerformanceDriverConfig } from './performance/scenario-driver';

type StoreConfig = Omit<AppConfig, 'dictation'> & {
  dictation?: unknown;
  migrated?: boolean;
  transcriptionMigrated?: boolean;
  shortcutsMigrated?: boolean;
  lastSeenReleaseNotesVersion?: string;
};

const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:8080/inference';
const CONFIG_STORE_FILENAME = 'shuddhalekhan-config.json';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = '';

/**
 * Resolve the install-time dictation identity before the store is created:
 * a missing config file is a genuinely new installation and receives the
 * promoted Live Dictation setup, while any pre-existing file keeps the
 * historical Batch/push-to-talk/local-Whisper defaults. The check must run
 * before electron-store creates the file on first run.
 */
const storeDirectory = preparePersistentStoreDirectory();
const storeFileExisted = existsSync(join(storeDirectory, CONFIG_STORE_FILENAME));
const installDefaults = resolveInstallDefaults(storeFileExisted);

const DEFAULT_TRANSCRIPTION: TranscriptionConfig = {
  activeProvider: installDefaults.transcriptionProviderId,
  providers: {
    localWhisperCpp: { endpoint: DEFAULT_LOCAL_ENDPOINT },
    openai: { baseUrl: DEFAULT_OPENAI_BASE_URL, model: DEFAULT_OPENAI_MODEL },
    azureSpeech: { endpoint: '', region: '' },
    googleCloudSpeech: { project: '', location: 'global', model: '', credentialSource: 'service-account' },
    nvidiaSpeechNim: { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
    customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
    whisperLiveKit: { baseUrl: 'http://localhost:8000', auth: 'none' },
  },
};

const store = new Store<StoreConfig>({
  name: 'shuddhalekhan-config',
  cwd: storeDirectory,
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
    shortcuts: {
      dictation: {
        binding: DEFAULT_SHORTCUTS.dictation.binding,
        activationMode: installDefaults.dictationActivationMode,
      },
      agent: DEFAULT_SHORTCUTS.agent,
    },
    dictation: { mode: installDefaults.dictationMode, formatter: null },
    agent: {
      enabled: false,
      provider: {
        baseUrl: '',
        model: '',
        apiKeyEnvVar: '',
        apiKeySource: 'environment',
        thinkingEnabled: true,
        reasoningEffort: 'medium',
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
    activeProvider: isTranscriptionProviderId(transcription?.activeProvider)
      ? transcription.activeProvider
      : 'local-whisper-cpp',
    providers: {
      localWhisperCpp: { endpoint },
      openai: transcription?.providers?.openai ?? { baseUrl: DEFAULT_OPENAI_BASE_URL, model: DEFAULT_OPENAI_MODEL },
      azureSpeech: transcription?.providers?.azureSpeech ?? { endpoint: '', region: '' },
      googleCloudSpeech: transcription?.providers?.googleCloudSpeech ?? { project: '', location: 'global', model: '', credentialSource: 'service-account' },
      nvidiaSpeechNim: transcription?.providers?.nvidiaSpeechNim ?? { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
      customOpenAiCompatible: transcription?.providers?.customOpenAiCompatible ?? { endpoint: '', model: '', auth: 'none', headerName: '' },
      whisperLiveKit: transcription?.providers?.whisperLiveKit ?? { baseUrl: 'http://localhost:8000', auth: 'none' },
    },
  });
  store.set('transcriptionMigrated', true);
}

maybeMigrateTranscriptionConfig();

function normalizeIntentShortcuts(
  stored: Partial<IntentShortcutConfig> | undefined,
  fallback: IntentShortcutConfig,
): IntentShortcutConfig {
  if (!stored) return { binding: fallback.binding, activationMode: fallback.activationMode };
  const binding = stored.binding == null
    ? (stored.binding === null ? null : fallback.binding)
    : normalizeBinding(stored.binding);
  return {
    binding,
    activationMode: stored.activationMode === 'toggle' ? 'toggle' : 'push-to-talk',
  };
}

function normalizeShortcutsConfig(stored: ShortcutsConfig | undefined): ShortcutsConfig {
  return {
    dictation: normalizeIntentShortcuts(stored?.dictation, DEFAULT_SHORTCUTS.dictation),
    agent: normalizeIntentShortcuts(stored?.agent, DEFAULT_SHORTCUTS.agent),
  };
}

function maybeMigrateShortcutsConfig(): void {
  if (store.get('shortcutsMigrated')) return;

  const sharedMode = store.get('recordingActivationMode') === 'toggle' ? 'toggle' : 'push-to-talk';
  const stored = store.get('shortcuts');
  // Upgraded stores have no stored per-intent modes, so both intents keep
  // deriving from the legacy shared mode. Fresh installs have no historical
  // shared mode to honor and seed the promoted dictation activation instead.
  const dictationActivation = storeFileExisted
    ? sharedMode
    : installDefaults.dictationActivationMode;
  store.set('shortcuts', {
    dictation: {
      binding: stored?.dictation?.binding !== undefined
        ? stored.dictation.binding
        : DEFAULT_SHORTCUTS.dictation.binding,
      activationMode: dictationActivation,
    },
    agent: {
      binding: stored?.agent?.binding !== undefined
        ? stored.agent.binding
        : DEFAULT_SHORTCUTS.agent.binding,
      activationMode: sharedMode,
    },
  });
  store.set('shortcutsMigrated', true);
}

maybeMigrateShortcutsConfig();

/**
 * Materialize the dictation block so the resolved install default becomes an
 * explicit stored choice: new installs lock in Live Dictation, upgraded stores
 * lock in Batch — both immune to later default changes and never silently
 * flipped by a restart.
 */
function persistNormalizedDictation(): void {
  const stored = store.get('dictation');
  const normalized = normalizeDictationConfig(stored);
  if (stored === undefined || JSON.stringify(stored ?? null) !== JSON.stringify(normalized)) {
    store.set('dictation', normalized);
  }
}

persistNormalizedDictation();

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
    activeProvider: isTranscriptionProviderId(storedTranscription?.activeProvider)
      ? storedTranscription.activeProvider
      : 'local-whisper-cpp',
    providers: {
      localWhisperCpp: { endpoint: localEndpoint },
      openai: storedTranscription?.providers?.openai ?? { baseUrl: DEFAULT_OPENAI_BASE_URL, model: DEFAULT_OPENAI_MODEL },
      azureSpeech: storedTranscription?.providers?.azureSpeech ?? { endpoint: '', region: '' },
      googleCloudSpeech: storedTranscription?.providers?.googleCloudSpeech ?? { project: '', location: 'global', model: '', credentialSource: 'service-account' },
      nvidiaSpeechNim: storedTranscription?.providers?.nvidiaSpeechNim ?? { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
      customOpenAiCompatible: storedTranscription?.providers?.customOpenAiCompatible ?? { endpoint: '', model: '', auth: 'none', headerName: '' },
      whisperLiveKit: storedTranscription?.providers?.whisperLiveKit ?? { baseUrl: 'http://localhost:8000', auth: 'none' },
    },
  };

  return isolatePerformanceDriverConfig({
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
    shortcuts: normalizeShortcutsConfig(store.get('shortcuts')),
    dictation: normalizeDictationConfig(store.get('dictation')),
    agent: {
      enabled: agent?.enabled ?? false,
      provider: {
        baseUrl: agent?.provider?.baseUrl ?? '',
        model: agent?.provider?.model ?? '',
        apiKeyEnvVar: agent?.provider?.apiKeyEnvVar ?? '',
        apiKeySource: agent?.provider?.apiKeySource === 'stored' ? 'stored' : 'environment',
        thinkingEnabled: agent?.provider?.thinkingEnabled ?? true,
        reasoningEffort: agent?.provider?.reasoningEffort === 'low'
          || agent?.provider?.reasoningEffort === 'high'
          ? agent.provider.reasoningEffort
          : 'medium',
      },
      mcpServers,
    },
  }, process.env);
}

export function setConfig<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
  if (key === 'shortcuts') {
    const shortcuts = normalizeShortcutsConfig(value as ShortcutsConfig);
    for (const intent of ['dictation', 'agent'] as const) {
      const other = intent === 'dictation' ? 'agent' : 'dictation';
      const verdict = assessBinding(shortcuts[intent].binding, shortcuts[other].binding);
      if (verdict.status === 'error') {
        throw new Error(verdict.message);
      }
    }
    const previousShortcuts = normalizeShortcutsConfig(store.get('shortcuts'));
    if (shortcuts.dictation.activationMode !== previousShortcuts.dictation.activationMode) {
      assertDictationCombination({
        dictation: normalizeDictationConfig(store.get('dictation')),
        shortcuts,
        transcription: store.get('transcription') ?? DEFAULT_TRANSCRIPTION,
      });
    }
    store.set(key, shortcuts as AppConfig[K]);
    return;
  }

  if (key === 'dictation') {
    const dictation = normalizeDictationConfig(value);
    assertDictationCombination({
      dictation,
      shortcuts: normalizeShortcutsConfig(store.get('shortcuts')),
      transcription: store.get('transcription') ?? DEFAULT_TRANSCRIPTION,
    });
    store.set(key, dictation as AppConfig[K]);
    return;
  }

  if (key === 'transcription') {
    const transcription = value as TranscriptionConfig;
    if (transcription.activeProvider !== store.get('transcription')?.activeProvider) {
      assertDictationCombination({
        dictation: normalizeDictationConfig(store.get('dictation')),
        shortcuts: normalizeShortcutsConfig(store.get('shortcuts')),
        transcription,
      });
    }
  }

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
        whisperLiveKit: existing?.providers?.whisperLiveKit ?? { baseUrl: 'http://localhost:8000', auth: 'none' },
      },
    });
  }
}

function isTranscriptionProviderId(value: unknown): value is TranscriptionProviderId {
  return value === 'local-whisper-cpp'
    || value === 'openai'
    || value === 'azure-speech'
    || value === 'google-cloud-speech-v2'
    || value === 'nvidia-speech-nim'
    || value === 'custom-open-ai-compatible'
    || value === 'whisper-live-kit';
}

function assertDictationCombination(input: {
  dictation: DictationConfig;
  shortcuts: ShortcutsConfig;
  transcription: TranscriptionConfig;
}): void {
  const error = getDictationCombinationError({
    mode: input.dictation.mode,
    activationMode: input.shortcuts.dictation.activationMode,
    capabilities: getTranscriptionTransportCapabilities(input.transcription.activeProvider),
    formatter: input.dictation.formatter,
  });
  if (error) throw new Error(error);
}

export function getLastSeenReleaseNotesVersion(): string | null {
  return store.get('lastSeenReleaseNotesVersion') ?? null;
}

export function setLastSeenReleaseNotesVersion(version: string): void {
  store.set('lastSeenReleaseNotesVersion', version);
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
