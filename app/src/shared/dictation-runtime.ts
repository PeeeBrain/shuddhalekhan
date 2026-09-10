import type {
  DictationConfig,
  DictationFormatterProfile,
  DictationMode,
  FormatterApiKeySource,
  RecordingActivationMode,
  RecordingPresentationEnvelope,
  RecordingTerminalOutcome,
  TranscriptionProviderId,
  TranscriptionTransportCapabilities,
} from '../types/ipc';

export function looksLikeRawApiKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_-]/.test(value.trim());
}

export const DEFAULT_DICTATION_CONFIG: DictationConfig = {
  mode: 'batch',
  formatter: null,
};

/** Out-of-the-box dictation identity resolved once per installation. */
export interface InstallDictationDefaults {
  dictationMode: DictationMode;
  dictationActivationMode: RecordingActivationMode;
  transcriptionProviderId: TranscriptionProviderId;
}

/**
 * Promoted first-run experience: Live Dictation with Toggle activation against
 * WhisperLiveKit. Only ever applied when no configuration store exists yet.
 */
export const PROMOTED_INSTALL_DEFAULTS: InstallDictationDefaults = {
  dictationMode: 'live',
  dictationActivationMode: 'toggle',
  transcriptionProviderId: 'whisper-live-kit',
};

/** Pre-promotion behavior kept for every store that already existed on disk. */
export const LEGACY_INSTALL_DEFAULTS: InstallDictationDefaults = {
  dictationMode: 'batch',
  dictationActivationMode: 'push-to-talk',
  transcriptionProviderId: 'local-whisper-cpp',
};

/**
 * Resolve install-time defaults from store-file existence. An absent store file
 * means a genuinely new installation; any existing file — including legacy v4
 * stores that predate dictation modes — keeps the historical defaults so no
 * user ever wakes up in a different dictation mode than the one they chose.
 */
export function resolveInstallDefaults(configStoreExists: boolean): InstallDictationDefaults {
  return configStoreExists ? LEGACY_INSTALL_DEFAULTS : PROMOTED_INSTALL_DEFAULTS;
}

const DICTATION_MODES = new Set<DictationMode>(['batch', 'live', 'corrected']);
const TRANSCRIPTION_TRANSPORT_CAPABILITIES = {
  'local-whisper-cpp': { batch: true, streaming: false },
  openai: { batch: true, streaming: false },
  'azure-speech': { batch: true, streaming: false },
  'google-cloud-speech-v2': { batch: true, streaming: false },
  'nvidia-speech-nim': { batch: true, streaming: false },
  'custom-open-ai-compatible': { batch: true, streaming: false },
  'whisper-live-kit': { batch: true, streaming: true },
} satisfies Record<TranscriptionProviderId, TranscriptionTransportCapabilities>;

export function normalizeDictationConfig(stored: unknown): DictationConfig {
  if (!stored || typeof stored !== 'object') {
    return { ...DEFAULT_DICTATION_CONFIG };
  }

  const record = stored as { mode?: unknown; formatter?: unknown };
  const mode = typeof record.mode === 'string' && DICTATION_MODES.has(record.mode as DictationMode)
    ? record.mode as DictationMode
    : 'batch';

  return {
    mode,
    formatter: normalizeFormatter(record.formatter),
  };
}

function normalizeFormatter(stored: unknown): DictationFormatterProfile | null {
  if (!stored || typeof stored !== 'object') return null;
  const record = stored as {
    baseUrl?: unknown;
    model?: unknown;
    apiKeyEnvVar?: unknown;
    apiKeySource?: unknown;
    processingConsent?: unknown;
  };
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : '';
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  if (!baseUrl || !model) return null;
  const apiKeyEnvVar = typeof record.apiKeyEnvVar === 'string' ? record.apiKeyEnvVar.trim() : '';
  const apiKeySource: FormatterApiKeySource = record.apiKeySource === 'stored' ? 'stored' : 'environment';
  const processingConsent = record.processingConsent === true;
  return { baseUrl, model, apiKeyEnvVar, apiKeySource, processingConsent };
}

export function classifyFormatterEndpoint(baseUrl: string): 'local' | 'remote' {
  try {
    const url = new URL(baseUrl);
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || /^127(?:\.\d{1,3}){3}$/.test(hostname)
      || hostname === '[::1]'
      || hostname === '::1';
    return loopback ? 'local' : 'remote';
  } catch {
    return 'remote';
  }
}

export function getFormatterCredentialError(
  formatter: DictationFormatterProfile,
): string | null {
  if (
    formatter.apiKeySource === 'environment'
    && looksLikeRawApiKey(formatter.apiKeyEnvVar)
  ) {
    return 'Enter the environment variable name for the formatter API key, not the key value.';
  }
  if (classifyFormatterEndpoint(formatter.baseUrl) !== 'remote') return null;
  if (formatter.apiKeySource === 'stored') return null;
  if (!formatter.apiKeyEnvVar) {
    return 'Remote Corrected Dictation requires an API key environment variable.';
  }
  return null;
}

export function getTranscriptionTransportCapabilities(
  providerId: TranscriptionProviderId,
): TranscriptionTransportCapabilities {
  return { ...TRANSCRIPTION_TRANSPORT_CAPABILITIES[providerId] };
}

export interface MaintainerRuntimeGates {
  runtimeShell: boolean;
  agentShell: boolean;
  streaming: boolean;
  directUnicode: boolean;
}

export function parseMaintainerRuntimeGates(
  env: NodeJS.ProcessEnv,
): MaintainerRuntimeGates {
  return {
    runtimeShell: env.SHUDDHALEKHAN_DISABLE_RUNTIME_SHELL !== '1',
    // Restores the legacy Agent toast window as a local maintainer rollback.
    agentShell: env.SHUDDHALEKHAN_DISABLE_AGENT_SHELL !== '1',
    streaming: env.SHUDDHALEKHAN_DISABLE_STREAMING !== '1',
    directUnicode: env.SHUDDHALEKHAN_DISABLE_DIRECT_UNICODE !== '1',
  };
}

export function getFormatterProfileError(
  formatter: DictationFormatterProfile | null,
): string | null {
  if (!formatter?.baseUrl || !formatter.model) {
    return 'Corrected Dictation requires a formatter profile.';
  }

  let url: URL;
  try {
    url = new URL(formatter.baseUrl);
  } catch {
    return 'Corrected Dictation requires a valid formatter URL.';
  }
  if (url.username || url.password) {
    return 'Corrected Dictation formatter URLs cannot contain credentials.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Corrected Dictation formatter URLs must use HTTP or HTTPS.';
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    || hostname === '[::1]';
  if (url.protocol === 'http:' && !loopback) {
    return 'Remote Corrected Dictation formatters must use HTTPS.';
  }

  const model = formatter.model;
  if (model.length > 128) {
    return 'Corrected Dictation formatter model is too long.';
  }
  for (let index = 0; index < model.length; index++) {
    const code = model.charCodeAt(index);
    if (code < 32 || code === 127) {
      return 'Corrected Dictation formatter model contains control characters.';
    }
  }
  return null;
}

export interface DictationCombinationInput {
  mode: DictationMode;
  activationMode: RecordingActivationMode;
  capabilities: TranscriptionTransportCapabilities;
  formatter: DictationFormatterProfile | null;
}

export function getAppConfigDictationError(
  config: {
    dictation: DictationConfig;
    shortcuts: { dictation: { activationMode: RecordingActivationMode } };
    transcription: { activeProvider: TranscriptionProviderId };
  },
): string | null {
  return getDictationCombinationError({
    mode: config.dictation.mode,
    activationMode: config.shortcuts.dictation.activationMode,
    capabilities: getTranscriptionTransportCapabilities(config.transcription.activeProvider),
    formatter: config.dictation.formatter,
  });
}

export function getDictationCombinationError(input: DictationCombinationInput): string | null {
  if (input.mode === 'live') {
    if (input.activationMode !== 'toggle') {
      return 'Live Dictation requires Toggle activation.';
    }
    if (!input.capabilities.streaming) {
      return 'Live Dictation requires a streaming-capable provider.';
    }
  }

  if (input.mode === 'corrected') {
    const profileError = getFormatterProfileError(input.formatter);
    if (profileError) return profileError;
    if (!input.formatter?.processingConsent) {
      return 'Corrected Dictation requires explicit processing consent.';
    }
    return getFormatterCredentialError(input.formatter);
  }

  return null;
}

export function getDictationRuntimeError(
  input: DictationCombinationInput,
  gates: MaintainerRuntimeGates,
): string | null {
  const combinationError = getDictationCombinationError(input);
  if (combinationError) return combinationError;
  if (input.mode === 'live' && !gates.streaming) {
    return 'Live Dictation is disabled by a local maintainer switch.';
  }
  if (input.mode === 'live' && !gates.directUnicode) {
    return 'Direct-Unicode insertion is disabled by a local maintainer switch.';
  }
  return null;
}

export function createRecordingPresentationEnvelope(input: {
  recordingSessionId: string;
  sequence: number;
  revision: number;
  capabilities: TranscriptionTransportCapabilities;
  streamingActive?: boolean;
  outcome?: RecordingTerminalOutcome;
}): RecordingPresentationEnvelope {
  return {
    recordingSessionId: input.recordingSessionId,
    sequence: input.sequence,
    revision: input.revision,
    capabilities: input.capabilities,
    ...(input.streamingActive !== undefined ? { streamingActive: input.streamingActive } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
  };
}
