import { DEFAULT_TOOL_POLICY, makeMcpToolPolicyKey } from '@shuddhalekhan/shared/mcp';
import { TRANSCRIPTION_PROVIDER_IDS } from '@shuddhalekhan/shared/providers';
import { DEFAULT_SARVAM_CONFIG, sarvamConfigSchema } from '@shuddhalekhan/shared/sarvam';
import Store from 'electron-store';
import { app } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import type { AppConfig, DictationConfig, IntentShortcutConfig, McpDiscoveredTool, RecordingActivationMode, ShortcutsConfig, TranscriptionConfig, TranscriptionProviderId } from '../types/ipc';
import { normalizeMcpServers } from '../agent/mcp-server-config';
import { assessBinding, DEFAULT_SHORTCUTS, normalizeBinding } from '../shared/shortcut-bindings';
import { getDictationConfigError, normalizeDictationConfig, resolveInstallDefaults } from '../shared/dictation-runtime';
import { preparePersistentStoreDirectory } from './store-path';
import { isManagedLocalThreadCount } from './managed-local-threads';
import { DEFAULT_MANAGED_LOCAL, managedLocalSelectionSchema, resolveManagedLocalSelection } from '../shared/managed-local-selection';
import { normalizeAgentProvider } from '../shared/agent-provider';
import { agentProviderSchema, getAgentProviderIssues } from '../shared/agent-provider-validation';
import { z } from 'zod';
import { normalizeTranscriptionTransition, getTranscriptionDictionaryError } from '../shared/transcription-features';
import { transcriptionSettingsPatchSchema } from './transcription-settings';

type StoreConfig = Omit<AppConfig, 'dictation' | 'whisperUrl'> & {
  whisperUrl?: string;
  chatGptHostId?: string;
  dictation?: unknown;
  migrated?: boolean;
  transcriptionMigrated?: boolean;
  shortcutsMigrated?: boolean;
  lastSeenReleaseNotesVersion?: string;
  /** Legacy shared activation mode, read only by the shortcuts migration. */
  recordingActivationMode?: RecordingActivationMode;
};

const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:8080/inference';
const CONFIG_STORE_FILENAME = 'shuddhalekhan-config.json';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = '';

/**
 * Resolve the install-time dictation identity before the store is created:
 * an installation with no config on disk receives Managed Local onboarding,
 * while any pre-existing installation keeps the historical
 * Batch/push-to-talk/local-Whisper defaults. Legacy `~/.speech-2-text` installs
 * have no stable store file yet but are still upgrades, so they must not be
 * promoted. The checks must run before electron-store creates the file on first
 * run.
 */
const storeDirectory = preparePersistentStoreDirectory();
const legacyConfigPath = join(app.getPath('home'), '.speech-2-text', 'config.json');
const storeFileExisted = existsSync(join(storeDirectory, CONFIG_STORE_FILENAME));
const existingInstallationExisted = storeFileExisted || existsSync(legacyConfigPath);
const installDefaults = resolveInstallDefaults(existingInstallationExisted);

const DEFAULT_TRANSCRIPTION: TranscriptionConfig = {
  activeProvider: installDefaults.transcriptionProviderId,
  providers: {
    localWhisperCpp: { endpoint: DEFAULT_LOCAL_ENDPOINT },
    openai: { baseUrl: DEFAULT_OPENAI_BASE_URL, model: DEFAULT_OPENAI_MODEL },
    sarvam: { ...DEFAULT_SARVAM_CONFIG },
    azureSpeech: { endpoint: '', region: '' },
    googleCloudSpeech: { project: '', location: 'global', model: '', credentialSource: 'service-account' },
    nvidiaSpeechNim: { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
    customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '',
      supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
    whisperLiveKit: { baseUrl: 'http://localhost:8000', auth: 'none' },
  },
};

const store = new Store<StoreConfig>({
  name: 'shuddhalekhan-config',
  cwd: storeDirectory,
  defaults: {
    transcription: DEFAULT_TRANSCRIPTION,
    managedLocalThreads: null,
    managedLocal: DEFAULT_MANAGED_LOCAL,
    selectedDeviceId: null,
    removeFillerWords: true,
    language: 'auto',
    task: 'transcribe',
    dictionary: [],
    pasteStrategy: {
      default: 'ctrl-v',
      overrides: {},
    },
    waylandBestEffortInsertion: false,
    setupChecklistDismissed: false,
    onboarding: { status: existingInstallationExisted ? 'complete' : 'pending' },
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
        reasoning: 'default',
      },
      mcpServers: [],
      disabledSkills: [],
      memoryEnabled: false,
    },
  },
});

let importedLegacyEndpoint: string | undefined;

// Migrate old config from ~/.speech-2-text/config.json on first run
function maybeMigrateLegacyConfig(): void {
  if (existsSync(legacyConfigPath) && !store.get('migrated')) {
    try {
      const raw = readFileSync(legacyConfigPath, 'utf-8');
      const legacy = JSON.parse(raw);

      if (typeof legacy.whisper_url === 'string') importedLegacyEndpoint = legacy.whisper_url;
      if (legacy.selected_device) store.set('selectedDeviceId', legacy.selected_device);
      if (typeof legacy.remove_filler_words === 'boolean') {
        store.set('removeFillerWords', legacy.remove_filler_words);
      }

      store.set('migrated', true);
      // Clean up legacy file
      try {
        unlinkSync(legacyConfigPath);
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

  const legacyEndpoint = importedLegacyEndpoint || store.get('whisperUrl') || DEFAULT_LOCAL_ENDPOINT;
  const transcription = store.get('transcription');
  const currentEndpoint = transcription?.providers?.localWhisperCpp?.endpoint;
  const endpoint = currentEndpoint && currentEndpoint !== DEFAULT_LOCAL_ENDPOINT
    ? currentEndpoint
    : legacyEndpoint;

  store.set('transcription', {
    activeProvider: isTranscriptionProviderId(transcription?.activeProvider)
      ? transcription.activeProvider
      : 'local-whisper-cpp',
    providers: normalizeTranscriptionProviders(transcription?.providers, endpoint),
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

/**
 * A stored binding the current rules refuse (e.g. one saved before paste chords
 * were reserved) reads as unassigned, so it is never grabbed and never blocks
 * saving other settings. The user rebinds it in Settings.
 */
function withoutRefusedBindings(shortcuts: ShortcutsConfig): ShortcutsConfig {
  const keep = ({ binding, activationMode }: IntentShortcutConfig): IntentShortcutConfig => ({
    binding: assessBinding(binding, null).status === 'error' ? null : binding,
    activationMode,
  });
  return { dictation: keep(shortcuts.dictation), agent: keep(shortcuts.agent) };
}

function maybeMigrateShortcutsConfig(): void {
  if (store.get('shortcutsMigrated')) return;

  const sharedMode = store.get('recordingActivationMode') === 'toggle' ? 'toggle' : 'push-to-talk';
  const stored = store.get('shortcuts');
  // Upgraded stores have no stored per-intent modes, so both intents keep
  // deriving from the legacy shared mode. Fresh installs have no historical
  // shared mode to honor and seed the promoted dictation activation instead.
  const dictationActivation = existingInstallationExisted
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
 * explicit stored choice: new installs lock in Managed Local Batch, upgraded stores
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
  const parsedProvider = agentProviderSchema.safeParse(agent?.provider ?? {});
  const provider = parsedProvider.success ? parsedProvider.data : undefined;
  const mcpServers = normalizeMcpServers(agent?.mcpServers);

  const storedTranscription = store.get('transcription');
  const localEndpoint = storedTranscription?.providers?.localWhisperCpp?.endpoint
    || store.get('whisperUrl')
    || DEFAULT_LOCAL_ENDPOINT;
  const transcription: TranscriptionConfig = {
    activeProvider: isTranscriptionProviderId(storedTranscription?.activeProvider)
      ? storedTranscription.activeProvider
      : 'local-whisper-cpp',
    providers: normalizeTranscriptionProviders(storedTranscription?.providers, localEndpoint),
  };

  return {
    whisperUrl: localEndpoint,
    transcription,
    managedLocalThreads: isManagedLocalThreadCount(store.get('managedLocalThreads'))
      ? store.get('managedLocalThreads') : null,
    managedLocal: resolveManagedLocalSelection(store.get('managedLocal')),
    selectedDeviceId: store.get('selectedDeviceId'),
    removeFillerWords: store.get('removeFillerWords'),
    language: store.get('language') ?? 'auto',
    task: store.get('task') ?? 'transcribe',
    dictionary: store.get('dictionary') ?? [],
    pasteStrategy: store.get('pasteStrategy') ?? { default: 'ctrl-v', overrides: {} },
    waylandBestEffortInsertion: store.get('waylandBestEffortInsertion') === true,
    setupChecklistDismissed: store.get('setupChecklistDismissed') ?? false,
    onboarding: store.get('onboarding')?.status === 'pending'
      ? { status: 'pending' }
      : { status: 'complete' },
    shortcuts: withoutRefusedBindings(normalizeShortcutsConfig(store.get('shortcuts'))),
    dictation: normalizeDictationConfig(store.get('dictation')),
    agent: {
      enabled: agent?.enabled ?? false,
      provider: { ...provider, ...normalizeAgentProvider(provider) },
      mcpServers,
      disabledSkills: z.array(z.string()).safeParse(agent?.disabledSkills).data ?? [],
      memoryEnabled: agent?.memoryEnabled === true,
      customInstructions: typeof agent?.customInstructions === 'string' ? agent.customInstructions : '',
    },
  };
}

export function getChatGptHostId(): string | undefined { return store.get('chatGptHostId'); }
export function setChatGptHostId(id: string): void { store.set('chatGptHostId', id); }

export function patchTranscriptionConfig(value: unknown): AppConfig {
  const patch = transcriptionSettingsPatchSchema.parse(value);
  const previous = getConfig();
  const next = normalizeTranscriptionTransition(previous, patch);
  if (patch.dictionary) {
    const error = getTranscriptionDictionaryError(next);
    const removingOnly = next.dictionary.length < previous.dictionary.length
      && next.dictionary.every(term => previous.dictionary.includes(term));
    if (error && !removingOnly) throw new Error(error);
  }
  assertShortcutBindings(next.shortcuts);
  assertDictationConfig(next.dictation);
  // electron-store's object overload commits the validated transition in one write.
  store.set({
    transcription: next.transcription, managedLocal: next.managedLocal,
    language: next.language, task: next.task, dictionary: next.dictionary,
    removeFillerWords: next.removeFillerWords, dictation: next.dictation, shortcuts: next.shortcuts,
  });
  return getConfig();
}

export function setConfig<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
  if (key === 'managedLocal') {
    const parsed = managedLocalSelectionSchema.safeParse(value);
    if (!parsed.success) throw new Error('Choose a supported local model and inference device.');
    store.set('managedLocal', parsed.data);
    return;
  }
  if (key === 'agent') {
    const parsed = z.object({ enabled: z.boolean(), provider: agentProviderSchema,
      disabledSkills: z.array(z.string().max(64)).max(256).optional(), memoryEnabled: z.boolean().optional(),
      customInstructions: z.string().max(4000).optional(),
    }).safeParse(value);
    if (!parsed.success) throw new Error('Provider settings contain an invalid value.');
    const previousAgent = store.get('agent');
    // Disabling must work even when an existing provider profile is invalid.
    if (previousAgent?.enabled && !parsed.data.enabled) {
      store.set('agent', { ...previousAgent, enabled: false });
      return;
    }
    const provider = parsed.data.provider;
    const issue = getAgentProviderIssues(provider).find(issue =>
      !(issue.field === 'baseUrl' && !provider.baseUrl.trim())
      && !(issue.field === 'model' && !provider.model.trim())
      && !(issue.field === 'apiKeyEnvVar' && !provider.apiKeyEnvVar.trim()));
    if (issue) throw new Error(issue.message);
    store.set('agent', { ...(value as AppConfig['agent']),
      provider: { ...provider, apiKeyEnvVar: normalizeAgentProvider(provider).apiKeyEnvVar } });
    return;
  }
  if (key === 'managedLocalThreads' && value !== null && !isManagedLocalThreadCount(value)) {
    throw new Error('Choose a whole-number thread count within the available CPU range.');
  }
  if (key === 'shortcuts') {
    const shortcuts = normalizeShortcutsConfig(value as ShortcutsConfig);
    assertShortcutBindings(shortcuts);
    store.set(key, shortcuts as AppConfig[K]);
    return;
  }

  if (key === 'dictation') {
    const dictation = normalizeDictationConfig(value);
    assertDictationConfig(dictation);
    store.set(key, dictation as AppConfig[K]);
    return;
  }

  if (key === 'transcription') {
    sarvamConfigSchema.parse((value as TranscriptionConfig).providers.sarvam);
  }

  if (key !== 'whisperUrl') store.set(key, value);
  if (key === 'whisperUrl') {
    // Preserve existing cloud provider configs; only update local
    const existing = store.get('transcription');
    store.set('transcription', {
      activeProvider: existing?.activeProvider ?? 'local-whisper-cpp',
      providers: normalizeTranscriptionProviders(existing?.providers, value as string),
    });
  }
}

function isTranscriptionProviderId(value: unknown): value is TranscriptionProviderId {
  return (TRANSCRIPTION_PROVIDER_IDS as readonly unknown[]).includes(value);
}

function assertDictationConfig(dictation: DictationConfig): void {
  const error = getDictationConfigError(dictation);
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
      const key = makeMcpToolPolicyKey(server.id, tool.name);
      if (!toolPolicies[key]) toolPolicies[key] = DEFAULT_TOOL_POLICY;
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

function assertShortcutBindings(shortcuts: ShortcutsConfig): void {
  for (const intent of ['dictation', 'agent'] as const) {
    const other = intent === 'dictation' ? 'agent' : 'dictation';
    const verdict = assessBinding(shortcuts[intent].binding, shortcuts[other].binding);
    if (verdict.status === 'error') throw new Error(verdict.message);
  }
}

function normalizeTranscriptionProviders(
  stored: TranscriptionConfig['providers'] | undefined,
  endpoint: string,
): TranscriptionConfig['providers'] {
  return {
    localWhisperCpp: { endpoint },
    openai: stored?.openai ?? structuredClone(DEFAULT_TRANSCRIPTION.providers.openai),
    sarvam: sarvamConfigSchema.safeParse(stored?.sarvam).data ?? structuredClone(DEFAULT_TRANSCRIPTION.providers.sarvam),
    azureSpeech: stored?.azureSpeech ?? structuredClone(DEFAULT_TRANSCRIPTION.providers.azureSpeech),
    googleCloudSpeech: stored?.googleCloudSpeech ?? structuredClone(DEFAULT_TRANSCRIPTION.providers.googleCloudSpeech),
    nvidiaSpeechNim: stored?.nvidiaSpeechNim ?? structuredClone(DEFAULT_TRANSCRIPTION.providers.nvidiaSpeechNim),
    customOpenAiCompatible: stored?.customOpenAiCompatible ?? structuredClone(DEFAULT_TRANSCRIPTION.providers.customOpenAiCompatible),
    whisperLiveKit: stored?.whisperLiveKit ?? structuredClone(DEFAULT_TRANSCRIPTION.providers.whisperLiveKit),
  };
}
