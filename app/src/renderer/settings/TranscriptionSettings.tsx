import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { X } from 'lucide-react';
import { SectionHeader, SettingsCard, SettingsPanel, SettingsPanelHeader } from './ui/SectionHeader';
import { Tag, ToggleRow, SelectRow, DraftTextRow, ReadOnlyRow } from './ui/rows';
import { Disclosure } from './ui/Disclosure';
import { SetupChecklist } from './SetupChecklist';
import { CredentialControl } from './ui/CredentialControl';
import { WHISPER_LANGUAGES, isLocalProviderUrl, looksLikeRawApiKey } from './settings-model';
import type { SettingsSectionProps } from './settings-section-props';
import type {
  AppConfig,
  CredentialKind,
  DictationMode,
  DictationFormatterProfile,
  FormatterApiKeySource,
  TranscriptionProviderId,
  TranscriptionReadiness,
  ManagedLocalDevice,
  ManagedLocalModelSnapshot,
  ManagedLocalSelection,
  ManagedLocalTarget,
  TranscriptionSettingsPatch,
} from '../../types/ipc';
import { cn } from '@/lib/utils';
import { useManagedLocalSnapshot } from './use-managed-local-snapshot';
import { ipcErrorMessage } from './use-settings-persistence';
import { DEFAULT_MANAGED_LOCAL } from '../../shared/managed-local-selection';
import {
  getAppConfigDictationError,
  classifyFormatterEndpoint,
} from '../../shared/dictation-runtime';
import {
  SARVAM_LANGUAGES,
  SARVAM_MODELS,
  SARVAM_MODES,
  sarvamLanguageCode,
} from '../../shared/sarvam';
import { getTranscriptionDictionaryError, resolveTranscriptionFeatures } from '../../shared/transcription-features';

type TestState = 'idle' | 'checking' | 'success' | 'failed';

const FIELD_ID_LOCAL_WHISPER_URL = 'whisper-url';
const FIELD_ID_CUSTOM_MODEL = 'custom-model';
const FIELD_ID_WHISPER_LIVE_KIT_BASE_URL = 'whisper-live-kit-base-url';
const FIELD_ID_NVIDIA_HEADER_NAME = 'nvidia-header-name';
const FIELD_ID_TASK = 'task';
const FIELD_ID_LANGUAGE = 'language';
const FIELD_ID_FILER = 'filler-words';
const FIELD_ID_DICTIONARY = 'dictionary';
const FIELD_ID_OPENAI_BASE_URL = 'openai-base-url';
const FIELD_ID_OPENAI_MODEL = 'openai-model';
const FIELD_ID_CUSTOM_ENDPOINT = 'custom-endpoint';
const FIELD_ID_CUSTOM_HEADER_NAME = 'custom-header-name';
const FIELD_ID_AZURE_ENDPOINT = 'azure-endpoint';
const FIELD_ID_AZURE_REGION = 'azure-region';
const FIELD_ID_GOOGLE_PROJECT = 'google-project';
const FIELD_ID_GOOGLE_LOCATION = 'google-location';
const FIELD_ID_GOOGLE_MODEL = 'google-model';
const FIELD_ID_NVIDIA_ENDPOINT = 'nvidia-endpoint';
const FIELD_ID_NVIDIA_MODEL = 'nvidia-model';
const FIELD_ID_PROVIDER = 'provider';
const FIELD_ID_LOCAL_THREADS = 'managed-local-threads';
const FIELD_ID_LOCAL_MODEL = 'managed-local-model';
const FIELD_ID_LOCAL_DEVICE = 'managed-local-device';
const FIELD_ID_DICTATION_MODE = 'dictation-mode';
const FIELD_ID_FORMATTER_BASE_URL = 'formatter-base-url';
const FIELD_ID_FORMATTER_MODEL = 'formatter-model';
const FIELD_ID_FORMATTER_CONSENT = 'formatter-consent';
const FIELD_ID_FORMATTER_KEY_SOURCE = 'formatter-key-source';
const FIELD_ID_FORMATTER_KEY_ENV = 'formatter-key-env';

interface ProviderOption {
  value: TranscriptionProviderId;
  label: string;
  description: string;
}

const PROVIDER_GROUPS: Array<{ label: 'Local' | 'Cloud' | 'Custom'; options: ProviderOption[] }> = [
  {
    label: 'Local',
    options: [
      { value: 'managed-local', label: 'Managed Local', description: 'Private local speech recognition managed by Shuddhalekhan.' },
      { value: 'local-whisper-cpp', label: 'Local whisper.cpp', description: 'Private whisper.cpp-compatible inference endpoint.' },
    ],
  },
  {
    label: 'Cloud',
    options: [
      { value: 'openai', label: 'OpenAI', description: 'OpenAI batch audio transcription.' },
      { value: 'sarvam', label: 'Sarvam AI', description: 'Saaras speech-to-text for Indian languages and English.' },
      { value: 'azure-speech', label: 'Microsoft Azure Speech', description: 'Azure Speech Fast Transcription.' },
      { value: 'google-cloud-speech-v2', label: 'Google Cloud Speech-to-Text v2', description: 'Google synchronous Speech-to-Text v2.' },
    ],
  },
  {
    label: 'Custom',
    options: [
      { value: 'nvidia-speech-nim', label: 'NVIDIA Speech NIM', description: 'Self-hosted NVIDIA offline transcription.' },
      { value: 'custom-open-ai-compatible', label: 'Custom OpenAI-compatible', description: 'A compatible private or local audio endpoint.' },
      { value: 'whisper-live-kit', label: 'WhisperLiveKit', description: 'Self-hosted Batch and Live Dictation with health and protocol readiness checks.' },
    ],
  },
];

const PROVIDER_OPTIONS = PROVIDER_GROUPS.flatMap((group) => group.options);

function ProviderSelector({
  value,
  status,
  error,
  onChange,
}: {
  value: TranscriptionProviderId;
  status: ProviderStatus;
  error?: string;
  onChange: (value: string) => void;
}) {
  const labelId = useId();
  const detailId = useId();
  const errorId = useId();
  const selected = PROVIDER_OPTIONS.find((option) => option.value === value)!;

  return (
    <div className="border-b border-border/50 py-3.5 last:border-b-0 space-y-2">
      <Label id={labelId} className="text-sm font-medium">Provider</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          className="w-full max-w-xl"
          aria-labelledby={labelId}
          aria-describedby={`${detailId}${error ? ` ${errorId}` : ''}`}
          aria-invalid={error ? true : undefined}
        >
          <SelectValue>{selected.label}</SelectValue>
        </SelectTrigger>
        <SelectContent className="max-w-xl">
          {PROVIDER_GROUPS.map((group) => (
            <SelectGroup key={group.label}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.options.map((option) => (
                <SelectItem key={option.value} value={option.value} className="py-2">
                  <span className="flex flex-col items-start">
                    <span>{option.label}</span>
                    <span className="text-xs font-normal text-muted-foreground">{option.description}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <div id={detailId} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Tag tone={status.tone}>{status.label}</Tag>
        <span>{selected.description}</span>
      </div>
      {error ? <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function providerCredentialKind(
  config: AppConfig,
  provider: TranscriptionProviderId,
): CredentialKind | null {
  if (provider === 'openai') return 'openai-api-key';
  if (provider === 'sarvam') return 'sarvam-api-key';
  if (provider === 'azure-speech') return 'azure-speech-key';
  if (provider === 'google-cloud-speech-v2') {
    return config.transcription.providers.googleCloudSpeech.credentialSource === 'service-account'
      ? 'google-service-account'
      : null;
  }
  if (provider === 'nvidia-speech-nim') {
    const auth = config.transcription.providers.nvidiaSpeechNim.auth;
    return auth === 'bearer' ? 'nvidia-nim-bearer' : auth === 'header' ? 'nvidia-nim-header' : null;
  }
  if (provider === 'custom-open-ai-compatible') {
    const auth = config.transcription.providers.customOpenAiCompatible.auth;
    return auth === 'bearer'
      ? 'custom-open-ai-compatible-bearer'
      : auth === 'header'
        ? 'custom-open-ai-compatible-header'
        : null;
  }
  if (provider === 'whisper-live-kit') {
    return config.transcription.providers.whisperLiveKit?.auth === 'bearer'
      ? 'whisper-live-kit-bearer'
      : null;
  }
  return null;
}

function providerFieldsReady(config: AppConfig, provider: TranscriptionProviderId): boolean {
  const providers = config.transcription.providers;
  switch (provider) {
    case 'managed-local':
    case 'sarvam':
      return true;
    case 'local-whisper-cpp':
      return Boolean(providers.localWhisperCpp.endpoint.trim());
    case 'openai':
      return Boolean(providers.openai.baseUrl.trim() && providers.openai.model.trim());
    case 'azure-speech':
      return Boolean(providers.azureSpeech.endpoint.trim() || providers.azureSpeech.region.trim());
    case 'google-cloud-speech-v2':
      return Boolean(
        providers.googleCloudSpeech.project.trim()
        && providers.googleCloudSpeech.location.trim()
        && providers.googleCloudSpeech.model.trim(),
      );
    case 'nvidia-speech-nim':
      return Boolean(providers.nvidiaSpeechNim.endpoint.trim() && providers.nvidiaSpeechNim.model.trim());
    case 'custom-open-ai-compatible':
      return Boolean(
        providers.customOpenAiCompatible.endpoint.trim()
        && providers.customOpenAiCompatible.model.trim(),
      );
    case 'whisper-live-kit':
      return Boolean(providers.whisperLiveKit?.baseUrl?.trim());
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validateLocalWhisperEndpoint(value: string): string | null {
  if (!value.trim()) return 'Endpoint URL is required.';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Endpoint must use HTTP or HTTPS.';
    }
    return null;
  } catch {
    return 'Enter a valid URL (e.g. http://localhost:8080/inference).';
  }
}

function validateOpenAiBaseUrl(value: string): string | null {
  if (!value.trim()) return 'Base URL is required.';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Base URL must use HTTP or HTTPS.';
    }
    return null;
  } catch {
    return 'Enter a valid URL (e.g. https://api.openai.com/v1).';
  }
}

function validateModelName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Model name is required.';
  if (trimmed.length > 128) return 'Model name is too long (max 128 characters).';
  return hasControlCharacters(trimmed) ? 'Model name contains control characters.' : null;
}

function validateGoogleModelSlug(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'This field is required.';
  if (trimmed.length > 128) return 'Value is too long (max 128 characters).';
  return hasControlCharacters(trimmed) ? 'Value contains control characters.' : null;
}

function validateNvidiaModelName(value: string): string | null {
  if (!value.trim()) return 'Model name is required.';
  if (value.trim().length > 128) return 'Model name is too long (max 128 characters).';
  return hasControlCharacters(value) ? 'Model name contains control characters.' : null;
}

function validateNvidiaEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? null
      : 'Endpoint must use HTTP or HTTPS.';
  } catch {
    return 'Enter a valid NVIDIA Speech NIM transcription endpoint.';
  }
}

function validateCustomEndpoint(value: string): string | null {
  if (!value.trim()) return 'Endpoint URL is required.';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Endpoint must use HTTP or HTTPS.';
    }
    return null;
  } catch {
    return 'Enter a valid URL (e.g. http://localhost:8000/v1/audio/transcriptions).';
  }
}

function validateWhisperLiveKitBaseUrl(value: string): string | null {
  if (!value.trim()) return 'Base URL is required.';
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return 'Endpoint URLs cannot contain credentials.';
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Endpoints must use HTTP or HTTPS.';
    }
    const hostname = parsed.hostname.toLowerCase();
    const loopback = hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || /^127(?:\.\d{1,3}){3}$/.test(hostname)
      || hostname === '[::1]';
    if (parsed.protocol === 'http:' && !loopback) return 'Remote endpoints must use HTTPS.';
    return null;
  } catch {
    return 'Enter a valid URL (e.g. http://localhost:8000).';
  }
}

function validateHeaderName(value: string): string | null {
  if (!value.trim()) return 'Header name is required.';
  return /^[!#$%&'*+\-.^_`|~\w]+$/.test(value.trim())
    ? null
    : 'Header name contains invalid characters.';
}

const PRIVACY_MESSAGES: Record<TranscriptionProviderId, string> = {
  'managed-local': 'Recorded audio stays on this device and is transcribed by Shuddhalekhan local speech recognition.',
  'local-whisper-cpp': 'Recorded audio is sent to the configured local endpoint for transcription.',
  'openai': 'Recorded audio is sent to OpenAI for transcription. Review OpenAI\'s data handling policies.',
  'sarvam': 'Recorded audio is sent to Sarvam AI for transcription. Review Sarvam\'s data handling policies.',
  'azure-speech': 'Recorded audio is sent to Microsoft Azure Speech for transcription. Review Microsoft\'s data handling policies.',
  'google-cloud-speech-v2': 'Recorded audio is sent to Google Cloud Speech-to-Text for transcription. Review Google Cloud data handling policies.',
  'nvidia-speech-nim': 'Recorded audio is sent to the configured NVIDIA Speech NIM endpoint for transcription.',
  'custom-open-ai-compatible': 'Recorded audio is sent to the configured custom endpoint for transcription.',
  'whisper-live-kit': 'Recorded audio is sent to your configured WhisperLiveKit service. The service receives audio only while recording or checking readiness.',
};

type SarvamConfig = AppConfig['transcription']['providers']['sarvam'];

const SARVAM_MODEL_LABELS: Record<SarvamConfig['model'], string> = {
  'saaras:v4': 'Saaras v4 (recommended)',
  'saaras:v3': 'Saaras v3',
};

const SARVAM_MODE_COPY: Record<SarvamConfig['mode'], { label: string; description: string }> = {
  transcribe: { label: 'Transcribe', description: 'Text in the spoken language\'s native script, with punctuation and numbers formatted.' },
  verbatim: { label: 'Verbatim', description: 'Word-for-word text with filler words and spoken numbers kept as said.' },
  translit: { label: 'Transliterate', description: 'Romanized text: the spoken language written in Latin script.' },
  codemix: { label: 'Code-mixed', description: 'English words in Latin script, Indian-language words in their native script.' },
};

const AUTH_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'none', label: 'None (no auth)' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'header', label: 'Custom header' },
];

export function TranscriptionSettings({
  config,
  persistence,
  onNavigate,
  settingsIpc,
}: SettingsSectionProps) {
  const { commitTranscription, fieldErrors } = persistence;
  const provider = config.transcription.activeProvider;
  const [transitionNotice, setTransitionNotice] = useState<string | null>(null);
  const [pendingLive, setPendingLive] = useState(false);
  const [formatterSetupOpen, setFormatterSetupOpen] = useState(false);
  // Unsaved formatter edits; only a profile main can keep (URL + model) is saved while not Corrected.
  const [formatterDraft, setFormatterDraft] = useState<DictationFormatterProfile | null>(null);
  // WhisperLiveKit readiness is owned here so the first-run checklist can only
  // mark the streaming step done from an actual readiness result.
  const [whisperLiveKitReadiness, setWhisperLiveKitReadiness] =
    useState<TranscriptionReadiness | null>(null);
  const localSelection = config.managedLocal ?? DEFAULT_MANAGED_LOCAL;
  const local = useManagedLocalSnapshot(
    settingsIpc,
    provider === 'managed-local' ? `${localSelection.model}:${localSelection.devices[localSelection.model]}` : null,
  );
  const localSnapshot = provider === 'managed-local' ? local.snapshot : null;
  const features = resolveTranscriptionFeatures(config, localSnapshot?.model.languages);
  const credentialReady = useCredentialReady(providerCredentialKind(config, provider), settingsIpc);
  const status = providerStatus(config, credentialReady, localModelInstalled(localSnapshot, localSelection));
  const engineLabel = provider === 'managed-local'
    ? localSnapshot?.catalog?.find((item) => item.key === localSelection.model)?.name ?? localSnapshot?.model.name ?? 'Managed Local'
    : provider === 'sarvam'
      ? config.transcription.providers.sarvam.model === 'saaras:v3' ? 'Saaras v3' : 'Saaras v4'
      : providerLabel(provider);

  /** Every dependent transcription change goes through main in one step; main may normalize it. */
  const transition: Transition = async (patch, fieldId) => {
    setTransitionNotice(null);
    const saved = await commitTranscription(patch, fieldId);
    if (saved) setTransitionNotice(describeNormalization({ ...config, ...patch }, saved));
    return saved;
  };
  const cleanupErrorId = useId();
  const modeErrorId = useId();
  const taskErrorId = useId();
  const languageErrorId = useId();

  useEffect(() => {
    if (provider !== 'whisper-live-kit') return;
    const off = settingsIpc.onTranscriptionReadinessChanged(setWhisperLiveKitReadiness);
    void settingsIpc.checkTranscriptionReadiness().then(setWhisperLiveKitReadiness).catch(() => {
      setWhisperLiveKitReadiness({
        providerId: 'whisper-live-kit',
        state: 'unavailable',
        message: 'Unable to check WhisperLiveKit readiness.',
        checkedAt: new Date().toISOString(),
      });
    });
    return () => off?.();
  }, [settingsIpc, provider]);
  const dictation = config.dictation;
  const storedDictationModeError = getAppConfigDictationError(config) ?? undefined;
  const formatter = formatterDraft ?? defaultFormatterProfile(dictation);
  const correctedError = getAppConfigDictationError({ ...config, dictation: { mode: 'corrected', formatter } });
  const pushToTalk = config.shortcuts.dictation.activationMode !== 'toggle';

  const sarvam = config.transcription.providers.sarvam;
  const sarvamVerbatim = provider === 'sarvam' && sarvam.mode === 'verbatim' && config.task === 'transcribe';
  const { language: languageSupport } = features;
  const languageOptions = languageSupport.kind === 'fixed'
    ? []
    : (provider === 'sarvam' ? SARVAM_LANGUAGES : WHISPER_LANGUAGES).filter((option) => option.value === 'auto'
      ? features.automaticLanguageDetection
      : languageSupport.codes?.includes(option.value) ?? true);
  // Sarvam accepts plain codes like `hi` as `hi-IN`; show the mapped option instead of a blank select.
  const languageValue = provider === 'sarvam'
    ? sarvamLanguageCode(config.language) ?? config.language
    : config.language;
  const languageError = languageSupport.kind === 'select' && !languageOptions.some((option) => option.value === languageValue)
    ? `${languageLabel(config.language)} is not supported by ${engineLabel}. Choose a supported language.`
    : undefined;
  const dictionaryError = features.dictionaryHints ? getTranscriptionDictionaryError(config) ?? undefined : undefined;
  const modeOptions = [
    { value: 'batch', label: MODE_LABELS.batch },
    ...(features.streaming ? [{ value: 'live', label: `${MODE_LABELS.live} (beta)` }] : []),
    { value: 'corrected', label: MODE_LABELS.corrected },
  ];
  const transcriptionStep = provider === 'whisper-live-kit'
    ? { label: 'Start WhisperLiveKit and check readiness', done: whisperLiveKitReadiness?.state === 'ready' }
    : {
      label: provider === 'managed-local'
        ? 'Install the local speech model'
        : provider === 'local-whisper-cpp' ? 'Set the whisper.cpp endpoint' : `Set up ${providerLabel(provider)}`,
      done: status.tone === 'success',
    };

  const handleProviderChange = (value: string) => {
    setPendingLive(false);
    void transition({
      transcription: { ...config.transcription, activeProvider: value as TranscriptionProviderId },
    }, FIELD_ID_PROVIDER);
  };

  const closeFormatterSetup = () => {
    setFormatterSetupOpen(false);
    setFormatterDraft(null);
  };

  const enableCorrected = async () => {
    if (await transition({ dictation: { mode: 'corrected', formatter } }, FIELD_ID_DICTATION_MODE)) closeFormatterSetup();
  };

  const handleDictationModeChange = (value: string) => {
    const mode = value as DictationMode;
    setPendingLive(false);
    if (mode === 'corrected') {
      // An incomplete formatter is set up in place instead of saving a broken Corrected mode.
      if (correctedError) setFormatterSetupOpen(true);
      else void enableCorrected();
      return;
    }
    closeFormatterSetup();
    if (mode === 'live' && pushToTalk) {
      setPendingLive(true);
      return;
    }
    void transition({ dictation: { ...dictation, mode } }, FIELD_ID_DICTATION_MODE);
  };

  const enableLiveWithToggle = async () => {
    const saved = await transition({
      dictation: { ...dictation, mode: 'live' },
      shortcuts: {
        ...config.shortcuts,
        dictation: { ...config.shortcuts.dictation, activationMode: 'toggle' },
      },
    }, FIELD_ID_DICTATION_MODE);
    if (saved) setPendingLive(false);
  };

  /** Outside Corrected, only a profile main keeps (URL + model) is saved; anything less stays a draft. */
  const saveFormatter = async (patch: Partial<DictationFormatterProfile>, fieldId: string) => {
    const next = { ...formatter, ...patch };
    setFormatterDraft(next);
    if (dictation.mode !== 'corrected' && !(next.baseUrl.trim() && next.model.trim())) return;
    if (await transition({ dictation: { ...dictation, formatter: next } }, fieldId)) setFormatterDraft(null);
  };

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Transcription"
        description="Where your recordings are turned into text, and how that text is cleaned up."
      />
      {!config.setupChecklistDismissed ? (
        <SetupChecklist
          config={config}
          onNavigate={onNavigate}
          persistence={persistence}
          transcriptionStep={transcriptionStep}
        />
      ) : null}
      <SettingsPanel>
        <SettingsPanelHeader title="Speech engine" />
        <SettingsCard>
        {provider === 'managed-local' ? (
          <>
            <ManagedLocalSection
              config={config}
              persistence={persistence}
              settingsIpc={settingsIpc}
              local={local}
              transition={transition}
            />
            <Disclosure label="Use a different provider" className="border-b border-border/50 py-3.5 last:border-b-0">
              <ProviderSelector
                value={provider}
                status={status}
                error={fieldErrors[FIELD_ID_PROVIDER]}
                onChange={handleProviderChange}
              />
            </Disclosure>
          </>
        ) : (
          <ProviderSelector
            value={provider}
            status={status}
            error={fieldErrors[FIELD_ID_PROVIDER]}
            onChange={handleProviderChange}
          />
        )}

        {provider === 'local-whisper-cpp' ? (
          <LocalWhisperSection config={config} persistence={persistence} settingsIpc={settingsIpc} />
        ) : null}

        {provider === 'openai' ? (
          <OpenAiSection config={config} persistence={persistence} settingsIpc={settingsIpc} transition={transition} />
        ) : null}

        {provider === 'sarvam' ? (
          <SarvamSection config={config} persistence={persistence} settingsIpc={settingsIpc} transition={transition} />
        ) : null}

        {provider === 'azure-speech' ? (
          <AzureSpeechSection config={config} persistence={persistence} settingsIpc={settingsIpc} />
        ) : null}

        {provider === 'google-cloud-speech-v2' ? (
          <GoogleCloudSpeechSection config={config} persistence={persistence} settingsIpc={settingsIpc} />
        ) : null}

        {provider === 'nvidia-speech-nim' ? (
          <NvidiaSpeechNimSection config={config} persistence={persistence} settingsIpc={settingsIpc} transition={transition} />
        ) : null}

        {provider === 'custom-open-ai-compatible' ? (
          <CustomOpenAiSection config={config} persistence={persistence} settingsIpc={settingsIpc} transition={transition} />
        ) : null}

        {provider === 'whisper-live-kit' ? (
          <WhisperLiveKitSection
            config={config}
            persistence={persistence}
            settingsIpc={settingsIpc}
            readiness={whisperLiveKitReadiness}
            onReadinessChange={setWhisperLiveKitReadiness}
          />
        ) : null}
        </SettingsCard>
      </SettingsPanel>
      {transitionNotice ? (
        <p role="status" className="-mt-4 px-1 text-xs leading-5 text-muted-foreground">{transitionNotice}</p>
      ) : null}

      <SettingsPanel>
        <SettingsPanelHeader title="Output" />
        <SettingsCard>
        {features.cleanup ? (
          <ToggleRow
            title="Clean transcription"
            description="Remove common filler words before dictation text is injected."
            checked={config.removeFillerWords}
            errorId={cleanupErrorId}
            error={fieldErrors[FIELD_ID_FILER]}
            onChange={(checked) => void transition({ removeFillerWords: checked }, FIELD_ID_FILER)}
          />
        ) : (
          <p role="note" className="border-b border-border/50 py-3.5 last:border-b-0 text-xs text-muted-foreground">
            {dictation.mode === 'live'
              ? 'Clean transcription is off in Live Dictation, so text appears as it is recognized. Your saved choice applies to Batch and Corrected Dictation.'
              : sarvamVerbatim
                ? 'Clean transcription is off while Sarvam verbatim mode is selected, so filler words stay exactly as spoken. Your saved choice applies to other modes.'
                : `Clean transcription is not available with ${engineLabel}. Your saved choice applies to other providers.`}
          </p>
        )}
        <SelectRow
          label="Dictation mode"
          value={dictation.mode === 'live' && !features.streaming ? '' : dictation.mode}
          options={modeOptions}
          description={`Batch inserts text once you stop.${features.streaming ? ' Live inserts text as you speak.' : ''} Corrected sends the finished transcript to a formatter model you set up.`}
          errorId={modeErrorId}
          error={storedDictationModeError ?? fieldErrors[FIELD_ID_DICTATION_MODE]}
          onChange={handleDictationModeChange}
        />
        {pendingLive ? (
          <div role="note" className="flex flex-wrap items-center gap-2 border-b border-border/50 py-3.5 last:border-b-0 text-xs text-muted-foreground">
            <span>Live Dictation needs Toggle activation, and your Dictation shortcut uses Push to Talk.</span>
            <Button size="xs" variant="secondary" onClick={() => void enableLiveWithToggle()}>
              Switch to Toggle and turn on Live
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setPendingLive(false)}>Cancel</Button>
          </div>
        ) : null}
        {dictation.mode === 'corrected' || formatterSetupOpen ? (
          <CorrectedDictationFormatterSection
            formatter={formatter}
            persistence={persistence}
            settingsIpc={settingsIpc}
            onChange={(patch, fieldId) => void saveFormatter(patch, fieldId)}
          />
        ) : null}
        {dictation.mode !== 'corrected' && formatterSetupOpen ? (
          <div className="flex flex-wrap items-center gap-3 border-b border-border/50 py-3.5 last:border-b-0">
            <Button size="sm" disabled={Boolean(correctedError)} onClick={() => void enableCorrected()}>
              Turn on Corrected Dictation
            </Button>
            <Button size="sm" variant="ghost" onClick={closeFormatterSetup}>Cancel</Button>
            {correctedError ? <span className="text-xs text-muted-foreground">{correctedError}</span> : null}
          </div>
        ) : null}
        {features.translation ? (
          <SelectRow
            label="Task"
            value={config.task}
            options={[
              { value: 'transcribe', label: 'Transcribe spoken language' },
              { value: 'translate', label: 'Translate speech to English' },
            ]}
            description={provider === 'sarvam'
              ? 'Translate always returns English text and replaces the Sarvam output mode.'
              : undefined}
            errorId={taskErrorId}
            error={fieldErrors[FIELD_ID_TASK]}
            onChange={(value) => void transition({ task: value as AppConfig['task'] }, FIELD_ID_TASK)}
          />
        ) : null}
        {languageSupport.kind === 'fixed' ? (
          <ReadOnlyRow
            label="Spoken language"
            value={languageLabel(languageSupport.value)}
            description={languageSupport.value === 'auto'
              ? `The installed model detects its supported languages automatically: ${localSnapshot?.model.languages.join(', ')}.`
              : `${engineLabel} transcribes English only.`}
          />
        ) : (
          <SelectRow
            label="Spoken language"
            value={languageValue}
            options={languageOptions}
            description={provider === 'sarvam'
              ? sarvam.model === 'saaras:v4'
                ? 'Sarvam supports 22 Indian languages and English, including global English accents on Saaras v4.'
                : 'Sarvam supports 22 Indian languages and Indian English.'
              : features.automaticLanguageDetection
                ? undefined
                : `${engineLabel} needs an explicit language. Shuddhalekhan does not substitute the Windows language.`}
            errorId={languageErrorId}
            error={fieldErrors[FIELD_ID_LANGUAGE] ?? languageError}
            onChange={(value) => void transition({ language: provider === 'sarvam' ? value.split('-')[0] : value }, FIELD_ID_LANGUAGE)}
          />
        )}
        {features.dictionaryHints ? (
          <DictionaryRow
            dictionary={config.dictionary}
            description={features.dictionaryMaxTerms !== null
              ? `Sent to ${engineLabel} as hints: up to ${features.dictionaryMaxTerms} names, brands, or technical terms. Press Enter to add.`
              : undefined}
            error={fieldErrors[FIELD_ID_DICTIONARY] ?? dictionaryError}
            validateAddition={(next) => getTranscriptionDictionaryError({ ...config, dictionary: next })}
            onChange={(next) => void transition({ dictionary: next }, FIELD_ID_DICTIONARY)}
          />
        ) : (
          <p role="note" className="border-b border-border/50 py-3.5 last:border-b-0 text-xs text-muted-foreground">
            {engineLabel} does not use dictionary hints
            {config.dictionary.length > 0
              ? `. Your ${config.dictionary.length} saved ${config.dictionary.length === 1 ? 'word stays' : 'words stay'} available for other providers.`
              : '.'}
          </p>
        )}
        </SettingsCard>
      </SettingsPanel>
      <PrivacyNote provider={provider} formatter={dictation.mode === 'corrected' ? dictation.formatter : null} />
    </div>
  );
}

type Transition = (patch: TranscriptionSettingsPatch, fieldId: string) => Promise<AppConfig | null>;

const MODE_LABELS: Record<DictationMode, string> = {
  batch: 'Batch Dictation',
  live: 'Live Dictation',
  corrected: 'Corrected Dictation',
};

function providerLabel(provider: TranscriptionProviderId): string {
  return PROVIDER_OPTIONS.find((option) => option.value === provider)!.label;
}

function languageLabel(code: string): string {
  return WHISPER_LANGUAGES.find((option) => option.value === code)?.label
    ?? SARVAM_LANGUAGES.find((option) => option.value === code)?.label
    ?? code;
}

/** Explains what main changed while saving a transition, or null when it saved what was asked. */
function describeNormalization(requested: AppConfig, saved: AppConfig): string | null {
  const engine = providerLabel(saved.transcription.activeProvider);
  const notes: string[] = [];
  if (requested.dictation.mode !== saved.dictation.mode) {
    notes.push(`${MODE_LABELS[saved.dictation.mode]} is on because ${engine} doesn't support ${MODE_LABELS[requested.dictation.mode]}.`);
  }
  if (requested.task !== saved.task) notes.push(`Task is now Transcribe because ${engine} doesn't translate.`);
  if (requested.language !== saved.language) {
    notes.push(`Spoken language is now ${languageLabel(saved.language)} because ${engine} doesn't support ${languageLabel(requested.language)}.`);
  }
  return notes.join(' ') || null;
}

/** Re-checks when the provider's credential kind changes or the vault reports a change; null while checking. */
function useCredentialReady(kind: CredentialKind | null, settingsIpc: SettingsSectionProps['settingsIpc']): boolean | null {
  const [result, setResult] = useState<{ kind: CredentialKind; ready: boolean } | null>(null);
  useEffect(() => {
    if (!kind) return;
    let current = true;
    let revision = 0;
    const check = () => {
      const request = ++revision;
      settingsIpc.getCredentialStatus(kind)
        .then((status) => {
          if (current && request === revision) setResult({ kind, ready: status.available && status.exists });
        })
        .catch(() => {
          if (current && request === revision) setResult({ kind, ready: false });
        });
    };
    const off = settingsIpc.onCredentialChanged((credential) => {
      if (credential === kind) check();
    });
    check();
    return () => { current = false; off?.(); };
  }, [kind, settingsIpc]);
  return kind === null ? true : result?.kind === kind ? result.ready : null;
}

/** Files for the selected device: Auto works with either backend; a legacy install still in use counts. */
function localModelInstalled(snapshot: ManagedLocalModelSnapshot | null, selection: ManagedLocalSelection): boolean | null {
  if (!snapshot) return null;
  const entry = snapshot.catalog?.find((item) => item.key === selection.model);
  if (!entry) return snapshot.state.kind === 'ready';
  const cpu = entry.cpu.state.kind === 'ready' || Boolean(entry.cpu.legacy?.inUse);
  const cuda = entry.cuda.state.kind === 'ready';
  const device = selection.devices[selection.model];
  return device === 'cuda' ? cuda : cpu;
}

type ProviderStatus = { label: string; tone: 'success' | 'warning' | 'neutral' };

/** Setup badge for the active provider. "Configured" means saved settings, never live reachability. */
function providerStatus(config: AppConfig, credentialReady: boolean | null, localInstalled: boolean | null): ProviderStatus {
  const provider = config.transcription.activeProvider;
  if (provider === 'managed-local') {
    return localInstalled === null
      ? { label: 'Checking setup', tone: 'neutral' }
      : localInstalled ? { label: 'Installed', tone: 'success' } : { label: 'Download required', tone: 'warning' };
  }
  if (!providerFieldsReady(config, provider)) return { label: 'Setup required', tone: 'warning' };
  if (provider === 'google-cloud-speech-v2' && config.transcription.providers.googleCloudSpeech.credentialSource === 'adc') {
    return { label: 'Uses system credentials, not checked', tone: 'neutral' };
  }
  return credentialReady === null
    ? { label: 'Checking setup', tone: 'neutral' }
    : credentialReady ? { label: 'Configured', tone: 'success' } : { label: 'Credential required', tone: 'warning' };
}

// Only the non-obvious behavior gets words: Auto's fallback and the GPU option's lack of one.
const DEVICE_DESCRIPTIONS: Record<ManagedLocalDevice, string> = {
  auto: 'Uses the GPU once its files are installed, otherwise the CPU.',
  cpu: '',
  cuda: 'No CPU fallback. Recording fails if the GPU cannot start.',
};

type ManagedLocalArtifact = ManagedLocalModelSnapshot['catalog'][number]['cpu'];

function ManagedLocalSection({ config, persistence, settingsIpc, local, transition }: Props & {
  local: ReturnType<typeof useManagedLocalSnapshot>;
  transition: Transition;
}) {
  const selection = config.managedLocal ?? DEFAULT_MANAGED_LOCAL;
  const device = selection.devices[selection.model];
  const { snapshot, loadError, refresh, accept } = local;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const modelGroupName = useId();
  const deviceErrorId = useId();
  const [draftThreads, setDraftThreads] = useState<number | null>(null);
  const threadsId = useId();
  const threadsDescriptionId = useId();
  const threadsErrorId = useId();
  const threadsError = persistence.fieldErrors[FIELD_ID_LOCAL_THREADS];
  const threads = draftThreads ?? config.managedLocalThreads ?? snapshot?.inference.defaultThreads ?? 1;
  const saveThreads = () => {
    if (draftThreads === null) return;
    const next = draftThreads;
    setDraftThreads(null);
    if (next === (config.managedLocalThreads ?? snapshot?.inference.defaultThreads) && !threadsError) return;
    void persistence.commit('managedLocalThreads', next, FIELD_ID_LOCAL_THREADS);
  };

  // Older snapshots have no catalog: fall back to the single primary model view.
  const catalog = snapshot?.catalog;
  const entry = catalog?.find((item) => item.key === selection.model);
  const cpu: ManagedLocalArtifact | null = entry?.cpu
    ?? (snapshot ? { downloadBytes: snapshot.model.downloadBytes, installedBytes: snapshot.model.installedBytes, state: snapshot.state } : null);
  const gpu = entry?.cuda;
  const runtime = snapshot?.runtime;
  const showGpuFiles = device !== 'cpu' || (gpu !== undefined && gpu.state.kind !== 'missing');
  const offerAlternatives = device === 'cuda' && (gpu?.state.kind !== 'ready' || runtime?.status === 'error');

  const saveDevice = (next: ManagedLocalDevice) => void persistence.commit('managedLocal', {
    ...selection,
    devices: { ...selection.devices, [selection.model]: next },
  }, FIELD_ID_LOCAL_DEVICE);

  // ponytail: one artifact action at a time; allow parallel CPU/GPU downloads if main supports it.
  const runAction = async (backend: ManagedLocalTarget['backend'], action: 'install' | 'delete' | 'delete-legacy') => {
    const target = entry ? { model: selection.model, backend } : undefined;
    setError('');
    setBusy(true);
    try {
      accept(await (action === 'install'
        ? settingsIpc.installManagedLocalModel(target)
        : settingsIpc.deleteManagedLocalModel(target && action === 'delete-legacy' ? { ...target, legacy: true } : target)));
    } catch (actionError) {
      setError(ipcErrorMessage(actionError, action === 'install'
        ? 'Installation failed. Retry.'
        : 'Could not delete these files. Retry.'));
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-border/50 py-3.5">
      {catalog && catalog.length > 1 ? (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Local speech model</legend>
          {catalog.map((item) => {
            const selected = item.key === selection.model;
            return (
              <label
                key={item.key}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border p-3',
                  selected ? 'border-primary/60 bg-primary/5' : 'border-border/60 hover:bg-muted/40',
                )}
              >
                <input
                  type="radio"
                  name={modelGroupName}
                  value={item.key}
                  checked={selected}
                  className="mt-1 accent-primary"
                  // The model decides language and dictionary support, so main normalizes the switch.
                  onChange={() => void transition({ managedLocal: { ...selection, model: item.key } }, FIELD_ID_LOCAL_MODEL)}
                />
                <span className="min-w-0 space-y-0.5">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {item.name}
                    {item.key === DEFAULT_MANAGED_LOCAL.model ? <Tag tone="info">Recommended</Tag> : null}
                  </span>
                  <span className="block text-xs leading-5 text-muted-foreground">{item.description}</span>
                  <span className="block text-xs text-muted-foreground">
                    {[
                      item.languages.join(', '),
                      item.cpu.state.kind === 'ready' || item.cpu.legacy?.inUse ? 'Installed' : null,
                      item.cuda.state.kind === 'ready' ? 'GPU ready' : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </label>
            );
          })}
          {persistence.fieldErrors[FIELD_ID_LOCAL_MODEL] ? (
            <p role="alert" className="text-xs text-destructive">{persistence.fieldErrors[FIELD_ID_LOCAL_MODEL]}</p>
          ) : null}
        </fieldset>
      ) : (
        <p className="text-sm font-medium">
          Local speech model
          {snapshot ? <span className="ml-2 text-xs font-normal text-muted-foreground">{entry?.name ?? snapshot.model.name}</span> : null}
        </p>
      )}
      {!snapshot ? (
        <p className="mt-1 text-xs text-muted-foreground">{loadError ? 'Could not check local speech models.' : 'Checking status…'}</p>
      ) : null}

      {entry ? (
        <div className="mt-4 border-t border-border/50">
          <SelectRow
            label="Processor"
            value={device}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'cpu', label: 'CPU' },
              { value: 'cuda', label: snapshot?.gpu?.name ?? 'NVIDIA GPU' },
            ]}
            description={[DEVICE_DESCRIPTIONS[device], device !== 'cpu' ? snapshot?.gpu?.message : ''].filter(Boolean).join(' ')}
            errorId={deviceErrorId}
            error={persistence.fieldErrors[FIELD_ID_LOCAL_DEVICE]}
            onChange={(value) => saveDevice(value as ManagedLocalDevice)}
          />
          {runtime ? <RuntimeStatus runtime={runtime} /> : null}
          {offerAlternatives ? (
            <div className="flex flex-wrap items-center gap-2 pb-3 text-xs text-muted-foreground">
              <span>
                {gpu?.state.kind !== 'ready' ? 'Install GPU files below, or switch processor.' : 'The GPU could not start.'}
              </span>
              <Button variant="secondary" size="xs" onClick={() => saveDevice('auto')}>Use Auto</Button>
              <Button variant="ghost" size="xs" onClick={() => saveDevice('cpu')}>Use CPU</Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {cpu ? (
        <div className="mt-2 divide-y divide-border/50 border-t border-border/50">
          <p className="py-3 text-xs leading-5 text-muted-foreground">
            Setup includes local punctuation and capitalization for CPU and GPU. Existing installs keep working; install any remaining files to enable it.
          </p>
          <ArtifactRow
            title={entry ? 'CPU files' : 'Model files'}
            artifact={cpu}
            installLabel={cpu.legacy?.inUse ? 'Install update' : 'Install'}
            deleteLabel={entry ? 'Delete CPU files' : 'Delete model'}
            busy={busy}
            onInstall={() => void runAction('cpu', 'install')}
            onDelete={() => void runAction('cpu', 'delete')}
          />
          {cpu.legacy ? (
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
              <div className="min-w-0 space-y-0.5">
                <p className="flex items-center gap-2 text-sm">
                  {cpu.legacy.name}
                  {cpu.legacy.inUse ? <Tag tone="info">In use</Tag> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatMegabytes(cpu.legacy.installedBytes)} · {cpu.legacy.inUse ? 'In use until the update is installed' : 'No longer used'}
                </p>
              </div>
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy}
                onClick={() => void runAction('cpu', 'delete-legacy')}>Delete previous files</Button>
            </div>
          ) : null}
          {gpu && showGpuFiles ? (
            <ArtifactRow
              title="GPU files"
              artifact={gpu}
              optional
              installLabel="Install"
              deleteLabel="Delete GPU files"
              busy={busy}
              onInstall={() => void runAction('cuda', 'install')}
              onDelete={() => void runAction('cuda', 'delete')}
            />
          ) : null}
        </div>
      ) : null}
      {/* A failed artifact already shows its error in its own row. */}
      {error && cpu?.state.kind !== 'error' && gpu?.state.kind !== 'error'
        ? <p className="mt-3 text-xs text-destructive" role="alert">{error}</p> : null}
      {snapshot && device !== 'cuda' ? (
        <div className="mt-4 space-y-2 border-t border-border/50 pt-3.5">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor={threadsId}>CPU threads</Label>
            <output htmlFor={threadsId} className="text-sm tabular-nums text-muted-foreground">{threads} of {snapshot.inference.maxThreads}</output>
          </div>
          <input
            id={threadsId}
            type="range"
            min={1}
            max={snapshot.inference.maxThreads}
            step={1}
            value={threads}
            disabled={snapshot.inference.maxThreads === 1}
            aria-valuetext={`${threads} inference ${threads === 1 ? 'thread' : 'threads'}`}
            aria-describedby={`${threadsDescriptionId}${threadsError ? ` ${threadsErrorId}` : ''}`}
            aria-invalid={threadsError ? true : undefined}
            className="w-full accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            onChange={(event) => setDraftThreads(Number(event.currentTarget.value))}
            onPointerUp={saveThreads}
            onKeyUp={saveThreads}
            onBlur={saveThreads}
          />
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
            <p id={threadsDescriptionId} className="max-w-md text-xs leading-5 text-muted-foreground">
              More threads finish sooner but use more battery.
            </p>
            <Button
              variant="ghost"
              size="xs"
              disabled={config.managedLocalThreads == null && draftThreads === null && !threadsError}
              onClick={() => {
                setDraftThreads(null);
                void persistence.commit('managedLocalThreads', null, FIELD_ID_LOCAL_THREADS);
              }}
            >Use default</Button>
          </div>
          {threadsError ? <p id={threadsErrorId} className="text-xs text-destructive" role="alert">{threadsError}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function RuntimeStatus({ runtime }: { runtime: ManagedLocalModelSnapshot['runtime'] }) {
  const backend = runtime.backend === 'cuda' ? 'NVIDIA GPU' : 'CPU';
  const tag = runtime.status === 'ready'
    ? { tone: runtime.backend === 'cuda' ? 'success' as const : 'neutral' as const, label: `Running on ${backend}` }
    : runtime.status === 'loading'
      ? { tone: 'info' as const, label: 'Starting' }
      : runtime.status === 'error'
        ? { tone: 'error' as const, label: 'Could not start' }
        : { tone: 'neutral' as const, label: 'Starts with the next recording' };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-3 text-xs" role="status">
      <Tag tone={tag.tone}>{tag.label}</Tag>
      {runtime.message ? (
        <span className={runtime.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>{runtime.message}</span>
      ) : null}
    </div>
  );
}

function ArtifactRow({ title, artifact, optional = false, installLabel, deleteLabel, busy, onInstall, onDelete }: {
  title: string;
  artifact: ManagedLocalArtifact;
  optional?: boolean;
  installLabel: string;
  deleteLabel: string;
  busy: boolean;
  onInstall: () => void;
  onDelete: () => void;
}) {
  const { state } = artifact;
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 space-y-0.5">
        <p className="flex items-center gap-2 text-sm">
          {title}
          {state.kind === 'ready' ? <Tag tone="success">Installed</Tag> : null}
        </p>
        {state.kind === 'ready' || state.kind === 'missing' ? (
          <p className="text-xs text-muted-foreground">
            {state.kind === 'ready' ? formatMegabytes(artifact.installedBytes) : `${formatMegabytes(artifact.downloadBytes)} download`}
          </p>
        ) : null}
        {state.kind === 'downloading' ? (
          <p className="text-xs" role="status">
            Downloading… {state.totalBytes > 0 ? Math.round(state.downloadedBytes / state.totalBytes * 100) : 0}%
            {' '}({formatMegabytes(state.downloadedBytes)} of {formatMegabytes(state.totalBytes)})
          </p>
        ) : null}
        {state.kind === 'installing' ? <p className="text-xs" role="status">Verifying and installing…</p> : null}
        {state.kind === 'error' ? <p className="text-xs text-destructive" role="alert">{state.message}</p> : null}
      </div>
      {state.kind === 'ready' ? (
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={onDelete}>{deleteLabel}</Button>
      ) : state.kind === 'downloading' || state.kind === 'installing' ? null : (
        <Button size="sm" variant={optional && state.kind !== 'error' ? 'secondary' : 'default'} disabled={busy} onClick={onInstall}>
          {state.kind === 'error'
            ? state.action === 'resume' ? 'Resume' : state.action === 'repair' ? 'Repair' : 'Retry'
            : installLabel}
        </Button>
      )}
    </div>
  );
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

interface Props {
  config: AppConfig;
  persistence: import('./use-settings-persistence').SettingsPersistence;
  settingsIpc: import('./settings-ipc').SettingsIpc;
}

function defaultFormatterProfile(dictation: AppConfig['dictation']): DictationFormatterProfile {
  return dictation.formatter ?? {
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: '',
    apiKeyEnvVar: '',
    apiKeySource: 'environment',
    processingConsent: false,
  };
}

function CorrectedDictationFormatterSection({
  formatter,
  persistence,
  settingsIpc,
  onChange,
}: {
  formatter: DictationFormatterProfile;
  persistence: import('./use-settings-persistence').SettingsPersistence;
  settingsIpc: import('./settings-ipc').SettingsIpc;
  onChange: (patch: Partial<DictationFormatterProfile>, fieldId: string) => void;
}) {
  const { fieldErrors, clearFieldError } = persistence;
  const endpointClass = classifyFormatterEndpoint(formatter.baseUrl);
  const apiKeySource = formatter.apiKeySource ?? 'environment';
  const formatterBaseUrlErrorId = useId();
  const formatterModelErrorId = useId();
  const formatterApiKeySourceErrorId = useId();
  const formatterApiKeyEnvVarErrorId = useId();
  const formatterConsentErrorId = useId();
  const apiKeyWarning = looksLikeRawApiKey(formatter.apiKeyEnvVar)
    ? 'Enter the environment variable name here, not the API key value.'
    : isLocalProviderUrl(formatter.baseUrl)
      ? 'Local formatters can leave the API key reference empty.'
      : undefined;

  return (
    <div className="border-b border-border/50 py-3.5 last:border-b-0 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Corrected Dictation formatter</p>
        <Tag tone={endpointClass === 'local' ? 'success' : 'warning'}>
          {endpointClass === 'local' ? 'Local processing' : 'Remote processing'}
        </Tag>
      </div>
      <p className="text-xs text-muted-foreground">
        Corrected Dictation sends finalized transcript text to a separate no-tools formatter after recognition.
        {endpointClass === 'remote'
          ? ' Remote formatters require HTTPS and explicit consent before transcript text is sent.'
          : ' Loopback formatters stay on this device.'}
      </p>
      <DraftTextRow
        label="Formatter base URL"
        value={formatter.baseUrl}
        placeholder="http://127.0.0.1:11434/v1"
        errorId={formatterBaseUrlErrorId}
        error={fieldErrors[FIELD_ID_FORMATTER_BASE_URL]}
        onCommit={(baseUrl) => onChange({ baseUrl }, FIELD_ID_FORMATTER_BASE_URL)}
        clearError={() => clearFieldError(FIELD_ID_FORMATTER_BASE_URL)}
      />
      <DraftTextRow
        label="Formatter model"
        value={formatter.model}
        placeholder="formatter"
        errorId={formatterModelErrorId}
        error={fieldErrors[FIELD_ID_FORMATTER_MODEL]}
        onCommit={(model) => onChange({ model }, FIELD_ID_FORMATTER_MODEL)}
        clearError={() => clearFieldError(FIELD_ID_FORMATTER_MODEL)}
      />
      <SelectRow
        label="Formatter API key source"
        value={apiKeySource}
        options={[
          { value: 'environment', label: 'Environment variable' },
          { value: 'stored', label: 'Saved in Shuddhalekhan' },
        ]}
        errorId={formatterApiKeySourceErrorId}
        error={fieldErrors[FIELD_ID_FORMATTER_KEY_SOURCE]}
        onChange={(value) => onChange({
          apiKeySource: value as FormatterApiKeySource,
          apiKeyEnvVar: value === 'stored' ? '' : formatter.apiKeyEnvVar,
        }, FIELD_ID_FORMATTER_KEY_SOURCE)}
      />
      {apiKeySource === 'environment' ? (
        <DraftTextRow
          label="Formatter API key environment variable"
          value={formatter.apiKeyEnvVar}
          placeholder="OPENAI_API_KEY"
          warning={apiKeyWarning}
          errorId={formatterApiKeyEnvVarErrorId}
          error={fieldErrors[FIELD_ID_FORMATTER_KEY_ENV]}
          onCommit={(apiKeyEnvVar) => onChange({ apiKeyEnvVar }, FIELD_ID_FORMATTER_KEY_ENV)}
        />
      ) : (
        <CredentialControl
          credential="dictation-formatter-api-key"
          label="Formatter API key"
          settingsIpc={settingsIpc}
        />
      )}
      <ToggleRow
        title="Allow transcript processing"
        description="Required for Corrected Dictation. Shuddhalekhan never stores formatter transcript content in Agent audit logs."
        checked={formatter.processingConsent}
        errorId={formatterConsentErrorId}
        error={fieldErrors[FIELD_ID_FORMATTER_CONSENT]}
        onChange={(checked) => onChange({ processingConsent: checked }, FIELD_ID_FORMATTER_CONSENT)}
      />
    </div>
  );
}

function LocalWhisperSection({ config, persistence, settingsIpc }: Props) {
  const { commit, fieldErrors, clearFieldError } = persistence;
  const localEndpoint = config.transcription.providers.localWhisperCpp.endpoint;
  const [draft, setDraft] = useState(localEndpoint);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [testState, setTestState] = useState<TestState>('idle');
  const errorId = useId();
  const labelId = useId();
  const inputId = useId();

  const testConnection = async () => {
    const candidate = draft;
    const error = validateLocalWhisperEndpoint(candidate);
    setValidationError(error);
    if (error) return;
    if (candidate !== localEndpoint) {
      await commit('transcription', {
        ...config.transcription,
        providers: {
          ...config.transcription.providers,
          localWhisperCpp: { endpoint: candidate },
        },
      }, FIELD_ID_LOCAL_WHISPER_URL);
    }
    setTestState('checking');
    const reachable = await settingsIpc.checkTranscriptionServer();
    setTestState(reachable ? 'success' : 'failed');
  };

  const fieldError = validationError ?? fieldErrors[FIELD_ID_LOCAL_WHISPER_URL];

  return (
    <div className="space-y-2 border-b border-border/50 py-3.5 last:border-b-0">
      <Label id={labelId} htmlFor={inputId} className="text-sm font-medium">
        Endpoint
      </Label>
      <Input
        id={inputId}
        value={draft}
        placeholder="http://localhost:8080/inference"
        onChange={(e) => {
          setDraft(e.target.value);
          setValidationError(null);
          clearFieldError(FIELD_ID_LOCAL_WHISPER_URL);
          setTestState('idle');
        }}
        onBlur={() => {
          if (draft === localEndpoint) return;
          const error = validateLocalWhisperEndpoint(draft);
          setValidationError(error);
          if (!error) {
            commit('transcription', {
              ...config.transcription,
              providers: {
                ...config.transcription.providers,
                localWhisperCpp: { endpoint: draft },
              },
            }, FIELD_ID_LOCAL_WHISPER_URL);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        aria-labelledby={labelId}
        aria-invalid={fieldError ? true : undefined}
        aria-describedby={fieldError ? errorId : undefined}
      />
      {fieldError ? (
        <p id={errorId} role="alert" className="text-xs text-destructive break-words">
          {fieldError}
        </p>
      ) : null}
      <div className="flex items-center gap-3 pt-1">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={testState === 'checking' || validateLocalWhisperEndpoint(draft) !== null}
          onClick={testConnection}
        >
          {testState === 'checking' ? 'Checking…' : 'Check server'}
        </Button>
        {testState === 'success' ? (
          <Tag tone="success">Reachable</Tag>
        ) : null}
        {testState === 'failed' ? (
          <div className="flex min-w-0 items-center gap-2">
            <Tag tone="error">Unavailable</Tag>
            <span className="text-xs text-destructive">
              Could not reach endpoint. Check that the whisper.cpp server is running.
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function OpenAiSection({ config, persistence, settingsIpc, transition }: Props & { transition: Transition }) {
  const { commit, fieldErrors } = persistence;
  const openai = config.transcription.providers.openai;

  return (
    <>
      <DraftTextRow
        label="Base URL"
        value={openai.baseUrl}
        placeholder="https://api.openai.com/v1"
        description="The /audio/transcriptions endpoint is appended automatically."
        errorId={useId()}
        error={fieldErrors[FIELD_ID_OPENAI_BASE_URL]}
        validate={validateOpenAiBaseUrl}
        onCommit={(value) => commit('transcription', {
          ...config.transcription,
          providers: { ...config.transcription.providers, openai: { ...openai, baseUrl: value } },
        }, FIELD_ID_OPENAI_BASE_URL)}
        clearError={() => persistence.clearFieldError(FIELD_ID_OPENAI_BASE_URL)}
      />
      <DraftTextRow
        label="Model"
        value={openai.model}
        placeholder="whisper-1"
        description="OpenAI Whisper model name, e.g. whisper-1."
        errorId={useId()}
        error={fieldErrors[FIELD_ID_OPENAI_MODEL]}
        validate={validateModelName}
        // The model decides translation and dictionary support, so main normalizes the change.
        onCommit={(value) => void transition({
          transcription: {
            ...config.transcription,
            providers: { ...config.transcription.providers, openai: { ...openai, model: value.trim() } },
          },
        }, FIELD_ID_OPENAI_MODEL)}
        clearError={() => persistence.clearFieldError(FIELD_ID_OPENAI_MODEL)}
      />
      <div className="border-b border-border/50 py-3.5 last:border-b-0">
        <CredentialControl
          credential="openai-api-key"
          label="OpenAI API key"
          settingsIpc={settingsIpc}
        />
      </div>
    </>
  );
}

function SarvamSection({ config, persistence, settingsIpc, transition }: Props & { transition: Transition }) {
  const { fieldErrors } = persistence;
  const sarvam = config.transcription.providers.sarvam;
  const modeErrorId = useId();
  const save = (next: SarvamConfig, field: string) => void transition({
    transcription: { ...config.transcription, providers: { ...config.transcription.providers, sarvam: next } },
  }, field);

  return (
    <>
      <SelectRow
        label="Model"
        value={sarvam.model}
        options={SARVAM_MODELS.map((model) => ({ value: model, label: SARVAM_MODEL_LABELS[model] }))}
        description={sarvam.model === 'saaras:v4'
          ? 'Latest Saaras model. Supports global English and dictionary key terms.'
          : 'Previous Saaras model. Indian English only, no dictionary key terms.'}
        errorId={useId()}
        error={fieldErrors['sarvam-model']}
        onChange={(value) => save({ ...sarvam, model: value as SarvamConfig['model'] }, 'sarvam-model')}
      />
      {config.task === 'transcribe' ? (
        <SelectRow
          label="Output mode"
          value={sarvam.mode}
          options={SARVAM_MODES.map((mode) => ({ value: mode, label: SARVAM_MODE_COPY[mode].label }))}
          description={SARVAM_MODE_COPY[sarvam.mode].description}
          errorId={modeErrorId}
          error={fieldErrors['sarvam-mode']}
          onChange={(value) => save({ ...sarvam, mode: value as SarvamConfig['mode'] }, 'sarvam-mode')}
        />
      ) : (
        <p role="note" className="border-b border-border/50 py-3.5 last:border-b-0 text-xs text-muted-foreground">
          Task is set to translate, so Sarvam returns English text. Set Task to transcribe to choose an output mode.
        </p>
      )}
      <div className="border-b border-border/50 py-3.5 last:border-b-0">
        <CredentialControl
          credential="sarvam-api-key"
          label="Sarvam API key"
          settingsIpc={settingsIpc}
        />
      </div>
      <p role="note" className="border-b border-border/50 py-3.5 last:border-b-0 text-xs text-muted-foreground">
        Recordings stop automatically at Sarvam's 30-second REST limit. Works with Batch and Corrected Dictation; Live Dictation is not available.
      </p>
    </>
  );
}

function AzureSpeechSection({ config, persistence, settingsIpc }: Props) {
  const { commit, fieldErrors } = persistence;
  const azure = config.transcription.providers.azureSpeech;

  const validateEndpoint = (value: string): string | null => {
    if (!value.trim()) {
      return azure.region.trim() ? null : 'Enter a resource endpoint or region.';
    }
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' ? null : 'Azure resource endpoint must use HTTPS.';
    } catch {
      return 'Enter a valid endpoint, e.g. https://my-resource.cognitiveservices.azure.com.';
    }
  };

  const validateRegion = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return azure.endpoint.trim() ? null : 'Enter a resource endpoint or region.';
    return /^[a-z0-9-]{2,64}$/i.test(trimmed)
      ? null
      : 'Region may contain only letters, numbers, and hyphens.';
  };

  return (
    <>
      <DraftTextRow
        label="Resource endpoint"
        value={azure.endpoint}
        placeholder="https://my-resource.cognitiveservices.azure.com"
        description="Paste the Endpoint value from your Azure Speech resource. If set, it takes precedence over region."
        errorId={useId()}
        error={fieldErrors[FIELD_ID_AZURE_ENDPOINT]}
        validate={validateEndpoint}
        onCommit={(value) => commit('transcription', {
          ...config.transcription,
          providers: {
            ...config.transcription.providers,
            azureSpeech: { ...azure, endpoint: value.trim() },
          },
        }, FIELD_ID_AZURE_ENDPOINT)}
        clearError={() => persistence.clearFieldError(FIELD_ID_AZURE_ENDPOINT)}
      />
      <DraftTextRow
        label="Region"
        value={azure.region}
        placeholder="eastus"
        description="Alternatively, enter the Azure resource region to use its regional Cognitive Services endpoint."
        errorId={useId()}
        error={fieldErrors[FIELD_ID_AZURE_REGION]}
        validate={validateRegion}
        onCommit={(value) => commit('transcription', {
          ...config.transcription,
          providers: {
            ...config.transcription.providers,
            azureSpeech: { ...azure, region: value.trim().toLowerCase() },
          },
        }, FIELD_ID_AZURE_REGION)}
        clearError={() => persistence.clearFieldError(FIELD_ID_AZURE_REGION)}
      />
      <div className="border-b border-border/50 py-3.5 last:border-b-0">
        <CredentialControl
          credential="azure-speech-key"
          label="Azure Speech key"
          settingsIpc={settingsIpc}
        />
      </div>
      <p role="note" className="border-b border-border/50 py-3.5 last:border-b-0 text-xs text-muted-foreground">
        Settings are checked locally. Shuddhalekhan does not send test audio or make a billable Azure request.
      </p>
    </>
  );
}

function GoogleCloudSpeechSection({ config, persistence, settingsIpc }: Props) {
  const { commit, fieldErrors } = persistence;
  const google = config.transcription.providers.googleCloudSpeech;
  const save = (next: typeof google, field: string) => commit('transcription', {
    ...config.transcription,
    providers: { ...config.transcription.providers, googleCloudSpeech: next },
  }, field);
  return (
    <>
      <DraftTextRow label="Project ID" value={google.project} placeholder="my-google-cloud-project"
        description="Google Cloud project that owns the Speech-to-Text request."
        errorId={useId()} error={fieldErrors[FIELD_ID_GOOGLE_PROJECT]}
        validate={(value) => /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(value.trim()) ? null : 'Enter a valid Google Cloud project ID.'}
        onCommit={(value) => save({ ...google, project: value.trim() }, FIELD_ID_GOOGLE_PROJECT)}
        clearError={() => persistence.clearFieldError(FIELD_ID_GOOGLE_PROJECT)} />
      <DraftTextRow label="Location" value={google.location} placeholder="global"
        description="Recognizer location, for example global, us, or europe-west4."
        errorId={useId()} error={fieldErrors[FIELD_ID_GOOGLE_LOCATION]}
        validate={(value) => /^[a-z0-9-]{1,63}$/.test(value.trim()) ? null : 'Enter a valid Google Cloud location.'}
        onCommit={(value) => save({ ...google, location: value.trim() }, FIELD_ID_GOOGLE_LOCATION)}
        clearError={() => persistence.clearFieldError(FIELD_ID_GOOGLE_LOCATION)} />
      <DraftTextRow label="Model" value={google.model} placeholder="short"
        description="Free-form Google recognition model slug. No model is selected automatically."
        errorId={useId()} error={fieldErrors[FIELD_ID_GOOGLE_MODEL]} validate={validateGoogleModelSlug}
        onCommit={(value) => save({ ...google, model: value.trim() }, FIELD_ID_GOOGLE_MODEL)}
        clearError={() => persistence.clearFieldError(FIELD_ID_GOOGLE_MODEL)} />
      {google.credentialSource === 'service-account' ? (
        <CredentialControl credential="google-service-account" label="Service-account JSON document" settingsIpc={settingsIpc} documentImport />
      ) : (
        <p role="note" className="border-b border-border/50 py-3.5 last:border-b-0 text-xs text-muted-foreground">
          Application Default Credentials are read by the main process from GOOGLE_APPLICATION_CREDENTIALS or the gcloud ADC file.
        </p>
      )}
      <Disclosure label="Advanced" className="border-b border-border/50 py-3.5 last:border-b-0 text-sm">
        <div className="mt-3">
          <SelectRow label="Credential source" value={google.credentialSource} errorId={useId()}
            options={[{ value: 'service-account', label: 'Imported service-account document' }, { value: 'adc', label: 'Application Default Credentials' }]}
            onChange={(value) => save({ ...google, credentialSource: value as typeof google.credentialSource }, 'google-credential-source')} />
        </div>
      </Disclosure>
      <p role="note" className="border-b border-border/50 py-3.5 last:border-b-0 text-xs text-muted-foreground">
        Recordings warn at 45 seconds and stop automatically at 55 seconds for Google's synchronous short-audio API. Setup validation makes no billable request.
      </p>
    </>
  );
}

function NvidiaSpeechNimSection({ config, persistence, settingsIpc, transition }: Props & { transition: Transition }) {
  const { commit, fieldErrors } = persistence;
  const nim = config.transcription.providers.nvidiaSpeechNim;
  const [testState, setTestState] = useState<TestState>('idle');
  const headerErrorId = useId();
  const save = (next: typeof nim, field: string) => commit('transcription', {
    ...config.transcription,
    providers: { ...config.transcription.providers, nvidiaSpeechNim: next },
  }, field);
  return (
    <>
      <DraftTextRow label="Endpoint" value={nim.endpoint} placeholder="http://localhost:9000/v1/audio/transcriptions"
        description="Complete OpenAI-compatible offline transcription endpoint on your NIM deployment."
        errorId={useId()} error={fieldErrors[FIELD_ID_NVIDIA_ENDPOINT]} validate={validateNvidiaEndpoint}
        onCommit={(value) => save({ ...nim, endpoint: value.trim() }, FIELD_ID_NVIDIA_ENDPOINT)}
        clearError={() => persistence.clearFieldError(FIELD_ID_NVIDIA_ENDPOINT)} />
      <DraftTextRow label="Model" value={nim.model} placeholder="nvidia/parakeet-ctc-1.1b-asr"
        description="Free-form model slug exposed by your NIM server."
        errorId={useId()} error={fieldErrors[FIELD_ID_NVIDIA_MODEL]} validate={validateNvidiaModelName}
        onCommit={(value) => save({ ...nim, model: value.trim() }, FIELD_ID_NVIDIA_MODEL)}
        clearError={() => persistence.clearFieldError(FIELD_ID_NVIDIA_MODEL)} />
      <SelectRow label="Authentication" value={nim.auth} options={AUTH_OPTIONS} errorId={useId()}
        onChange={(value) => save({ ...nim, auth: value as typeof nim.auth, headerName: value === 'header' ? nim.headerName : '' }, 'nvidia-auth')} />
      {nim.auth === 'bearer' ? <CredentialControl credential="nvidia-nim-bearer" label="Bearer token" settingsIpc={settingsIpc} /> : null}
      {nim.auth === 'header' ? (
        <>
          <DraftTextRow label="Header name" value={nim.headerName} placeholder="X-API-Key"
            description="Secret header used by your reverse proxy." errorId={headerErrorId} error={fieldErrors[FIELD_ID_NVIDIA_HEADER_NAME]}
            validate={(value) => /^[!#$%&'*+\-.^_`|~\w]+$/.test(value.trim()) ? null : 'Header name contains invalid characters.'}
            onCommit={(value) => save({ ...nim, headerName: value.trim() }, FIELD_ID_NVIDIA_HEADER_NAME)}
            clearError={() => persistence.clearFieldError(FIELD_ID_NVIDIA_HEADER_NAME)} />
          <CredentialControl credential="nvidia-nim-header" label="Secret header value" settingsIpc={settingsIpc} />
        </>
      ) : null}
      {nim.auth === 'none' ? <CheckServerTest provider="nvidia-speech-nim" settingsIpc={settingsIpc} testState={testState} setTestState={setTestState} /> : null}
      <ModelCapabilities
        subject="NIM model"
        capabilities={nim}
        onChange={(key, checked) => void transition({
          transcription: {
            ...config.transcription,
            providers: { ...config.transcription.providers, nvidiaSpeechNim: { ...nim, [key]: checked } },
          },
        }, `nvidia-${key}`)}
      />
      <p role="note" className="border-b border-border/50 py-3.5 last:border-b-0 text-xs text-muted-foreground">
        This endpoint is user-hosted, not an NVIDIA managed cloud service. Speech NIM typically requires a supported GPU server or WSL2 deployment.
      </p>
    </>
  );
}

type ModelCapability = 'supportsAutomaticLanguageDetection' | 'supportsTranslation' | 'supportsDictionaryHints';

/** Self-hosted endpoints declare what their model supports; the resolver treats a missing flag as supported. */
function ModelCapabilities({ subject, capabilities, onChange }: {
  subject: string;
  capabilities: Partial<Record<ModelCapability, boolean>>;
  onChange: (key: ModelCapability, checked: boolean) => void;
}) {
  const errorId = useId();
  const rows: Array<{ key: ModelCapability; title: string; description: string }> = [
    { key: 'supportsAutomaticLanguageDetection', title: 'Automatic language detection', description: `Enable only if the selected ${subject} declares support.` },
    { key: 'supportsTranslation', title: 'Translation', description: `Enable only if the selected ${subject} and endpoint support translation.` },
    { key: 'supportsDictionaryHints', title: 'Dictionary hints', description: 'Send personal dictionary terms as an OpenAI-compatible prompt.' },
  ];
  return (
    <Disclosure label="Advanced model capabilities" className="border-b border-border/50 py-3.5 last:border-b-0 text-sm">
      <div className="mt-2">
        {rows.map((row) => (
          <ToggleRow
            key={row.key}
            title={row.title}
            description={row.description}
            checked={capabilities[row.key] ?? true}
            errorId={`${errorId}-${row.key}`}
            onChange={(checked) => onChange(row.key, checked)}
          />
        ))}
      </div>
    </Disclosure>
  );
}

function CustomOpenAiSection({ config, persistence, settingsIpc, transition }: Props & { transition: Transition }) {
  const { commit, fieldErrors } = persistence;
  const custom = config.transcription.providers.customOpenAiCompatible;
  const [testState, setTestState] = useState<TestState>('idle');
  const endpointErrorId = useId();
  const headerNameErrorId = useId();
  const authErrorId = useId();

  const handleAuthChange = (value: string) => {
    commit('transcription', {
      ...config.transcription,
      providers: {
        ...config.transcription.providers,
        customOpenAiCompatible: { ...custom, auth: value as 'none' | 'bearer' | 'header', headerName: value !== 'header' ? '' : custom.headerName },
      },
    }, 'custom-auth');
  };

  return (
    <>
      <DraftTextRow
        label="Endpoint"
        value={custom.endpoint}
        placeholder="http://localhost:8000/v1/audio/transcriptions"
        description="Complete endpoint URL for the OpenAI-compatible API."
        errorId={endpointErrorId}
        error={fieldErrors[FIELD_ID_CUSTOM_ENDPOINT]}
        validate={validateCustomEndpoint}
        onCommit={(value) => commit('transcription', {
          ...config.transcription,
          providers: { ...config.transcription.providers, customOpenAiCompatible: { ...custom, endpoint: value } },
        }, FIELD_ID_CUSTOM_ENDPOINT)}
        clearError={() => persistence.clearFieldError(FIELD_ID_CUSTOM_ENDPOINT)}
      />
      <DraftTextRow
        label="Model"
        value={custom.model}
        placeholder="whisper-1"
        description="Model name for the OpenAI-compatible API."
        errorId={useId()}
        error={fieldErrors[FIELD_ID_CUSTOM_MODEL]}
        validate={validateModelName}
        onCommit={(value) => commit('transcription', {
          ...config.transcription,
          providers: { ...config.transcription.providers, customOpenAiCompatible: { ...custom, model: value.trim() } },
        }, FIELD_ID_CUSTOM_MODEL)}
        clearError={() => persistence.clearFieldError(FIELD_ID_CUSTOM_MODEL)}
      />
      <SelectRow
        label="Authentication"
        value={custom.auth}
        options={AUTH_OPTIONS}
        errorId={authErrorId}
        onChange={handleAuthChange}
      />
      {custom.auth === 'bearer' ? (
        <div className="border-b border-border/50 py-3.5 last:border-b-0">
          <CredentialControl
            credential="custom-open-ai-compatible-bearer"
            label="Bearer token"
            settingsIpc={settingsIpc}
          />
        </div>
      ) : null}
      {custom.auth === 'header' ? (
        <>
          <DraftTextRow
            label="Header name"
            value={custom.headerName}
            placeholder="X-API-Key"
            description="The HTTP header that carries the secret value."
            errorId={headerNameErrorId}
            error={fieldErrors[FIELD_ID_CUSTOM_HEADER_NAME]}
            validate={validateHeaderName}
            onCommit={(value) => commit('transcription', {
              ...config.transcription,
              providers: { ...config.transcription.providers, customOpenAiCompatible: { ...custom, headerName: value.trim() } },
            }, FIELD_ID_CUSTOM_HEADER_NAME)}
            clearError={() => persistence.clearFieldError(FIELD_ID_CUSTOM_HEADER_NAME)}
          />
          <div className="border-b border-border/50 py-3.5 last:border-b-0">
            <CredentialControl
              credential="custom-open-ai-compatible-header"
              label="Secret header value"
              settingsIpc={settingsIpc}
            />
          </div>
        </>
      ) : null}
      {custom.auth === 'none' ? (
        <CheckServerTest provider="custom-open-ai-compatible" settingsIpc={settingsIpc} testState={testState} setTestState={setTestState} />
      ) : null}
      <ModelCapabilities
        subject="model"
        capabilities={custom}
        onChange={(key, checked) => void transition({
          transcription: {
            ...config.transcription,
            providers: { ...config.transcription.providers, customOpenAiCompatible: { ...custom, [key]: checked } },
          },
        }, `custom-${key}`)}
      />
    </>
  );
}

function WhisperLiveKitSection({
  config,
  persistence,
  settingsIpc,
  readiness,
  onReadinessChange,
}: Props & {
  readiness: TranscriptionReadiness | null;
  onReadinessChange: (readiness: TranscriptionReadiness | null) => void;
}) {
  const { commit, fieldErrors } = persistence;
  const provider = config.transcription.providers.whisperLiveKit ?? {
    baseUrl: 'http://localhost:8000',
    auth: 'none' as const,
  };
  const save = (next: typeof provider, field: string) => {
    onReadinessChange(null);
    return commit('transcription', {
      ...config.transcription,
      providers: { ...config.transcription.providers, whisperLiveKit: next },
    }, field);
  };

  return (
    <>
      <DraftTextRow
        label="Base URL"
        value={provider.baseUrl}
        placeholder="http://localhost:8000"
        description="The service root. Shuddhalekhan derives /health, /asr, and /v1/audio/transcriptions from it."
        errorId={useId()}
        error={fieldErrors[FIELD_ID_WHISPER_LIVE_KIT_BASE_URL]}
        validate={validateWhisperLiveKitBaseUrl}
        onCommit={(value) => save({ ...provider, baseUrl: value.trim() }, FIELD_ID_WHISPER_LIVE_KIT_BASE_URL)}
        clearError={() => persistence.clearFieldError(FIELD_ID_WHISPER_LIVE_KIT_BASE_URL)}
      />
      <SelectRow
        label="Authentication"
        value={provider.auth}
        options={[
          { value: 'none', label: 'None (local service)' },
          { value: 'bearer', label: 'Bearer token' },
        ]}
        errorId={useId()}
        description="Bearer tokens are stored in the secure credential vault and passed to health, batch, and WebSocket requests."
        onChange={(value) => save({ ...provider, auth: value as typeof provider.auth }, 'whisper-live-kit-auth')}
      />
      {provider.auth === 'bearer' ? (
        <CredentialControl
          credential="whisper-live-kit-bearer"
          label="Bearer token"
          settingsIpc={settingsIpc}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-3 border-b border-border/50 py-3.5 last:border-b-0">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={readiness?.state === 'checking'}
          onClick={() => void settingsIpc.checkTranscriptionReadiness().then(onReadinessChange)}
        >
          {readiness?.state === 'checking' ? 'Checking…' : 'Check readiness'}
        </Button>
        {readiness ? <WhisperLiveKitReadinessTag readiness={readiness} /> : null}
      </div>
      <p role="note" className="border-b border-border/50 py-3.5 last:border-b-0 text-xs text-muted-foreground">
        WhisperLiveKit is a user-hosted service. Batch Dictation sends audio to its REST endpoint and Live Dictation streams it over a WebSocket while you record; readiness opens a short-lived handshake socket and keeps no idle ASR connection.
      </p>
    </>
  );
}

function WhisperLiveKitReadinessTag({ readiness }: { readiness: TranscriptionReadiness }) {
  const tone = readiness.state === 'ready'
    ? 'success'
    : readiness.state === 'degraded'
      ? 'warning'
      : readiness.state === 'checking'
        ? 'neutral'
        : 'error';
  const label = readiness.state === 'ready'
    ? 'Ready'
    : readiness.state === 'degraded'
      ? 'Degraded'
      : readiness.state === 'checking'
        ? 'Checking'
        : 'Unavailable';
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Tag tone={tone}>{label}</Tag>
      <span className="text-xs text-muted-foreground">{readiness.message}</span>
    </div>
  );
}

interface CheckServerTestProps {
  provider: string;
  settingsIpc: import('./settings-ipc').SettingsIpc;
  testState: TestState;
  setTestState: (state: TestState) => void;
}

function CheckServerTest({ provider, settingsIpc, testState, setTestState }: CheckServerTestProps) {
  const labelId = useId();

  const check = async () => {
    setTestState('checking');
    const reachable = await settingsIpc.checkTranscriptionServer();
    setTestState(reachable ? 'success' : 'failed');
  };

  if (provider === 'local-whisper-cpp') return null; // handled inline

  return (
    <div className="flex items-center gap-3 border-b border-border/50 py-3.5 last:border-b-0">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={testState === 'checking'}
        onClick={check}
        aria-describedby={testState !== 'idle' ? labelId : undefined}
      >
        {testState === 'checking' ? 'Checking…' : 'Check connectivity'}
      </Button>
      {testState === 'success' ? (
        <span id={labelId}><Tag tone="success">Reachable</Tag></span>
      ) : null}
      {testState === 'failed' ? (
        <span id={labelId} className="flex items-center gap-2">
          <Tag tone="error">Unreachable</Tag>
          <span className="text-xs text-muted-foreground">Confirm the endpoint URL and that the service is running.</span>
        </span>
      ) : null}
    </div>
  );
}

function formatterHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'the formatter endpoint';
  }
}

function PrivacyNote({ provider, formatter }: {
  provider: TranscriptionProviderId;
  /** The active Corrected Dictation formatter, if any. */
  formatter: DictationFormatterProfile | null;
}) {
  return (
    <p
      role="note"
      aria-label="Transcription privacy note"
      className="-mt-4 px-1 text-xs leading-5 text-muted-foreground/80"
    >
      {PRIVACY_MESSAGES[provider]}
      {formatter
        ? classifyFormatterEndpoint(formatter.baseUrl) === 'remote'
          ? ` Corrected Dictation also sends transcript text to ${formatterHost(formatter.baseUrl)} for formatting.`
          : ' Corrected Dictation formats transcript text on this device.'
        : null}
    </p>
  );
}

interface DictionaryRowProps {
  dictionary: string[];
  description?: string;
  error?: string;
  /** Rejects an addition before it is saved; removals always go through so an oversized list can shrink. */
  validateAddition: (next: string[]) => string | null;
  onChange: (next: string[]) => void;
}

function DictionaryRow({ dictionary, description, error, validateAddition, onChange }: DictionaryRowProps) {
  const [inputValue, setInputValue] = useState('');
  const [additionError, setAdditionError] = useState<string | null>(null);
  const errorId = useId();

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      const newWord = inputValue.trim();
      if (dictionary.includes(newWord)) {
        setInputValue('');
        return;
      }
      const next = [...dictionary, newWord];
      const rejection = validateAddition(next);
      setAdditionError(rejection);
      if (rejection) return;
      onChange(next);
      setInputValue('');
    }
  };

  const removeWord = (wordToRemove: string) => {
    setAdditionError(null);
    onChange(dictionary.filter((word) => word !== wordToRemove));
  };
  const shownError = additionError ?? error;

  return (
    <div className="space-y-3 border-b border-border/50 py-3.5 last:border-b-0">
      <div className="space-y-1">
        <Label className="text-sm font-medium">Personal dictionary</Label>
        <p className="text-xs text-muted-foreground">
          {description ?? 'Add specific names, technical terms, or acronyms to help transcription. Press Enter to add.'}
        </p>
      </div>
      <Input
        value={inputValue}
        onChange={(e) => {
          setInputValue(e.target.value);
          setAdditionError(null);
        }}
        onKeyDown={handleKeyDown}
        placeholder="Type a word and press Enter…"
        aria-label="Add dictionary word"
        aria-invalid={shownError ? true : undefined}
        aria-describedby={shownError ? errorId : undefined}
      />
      <FieldError id={errorId} error={shownError} />
      <div className="flex flex-wrap gap-2">
        {dictionary.map((word) => (
          <span
            key={word}
            className="group inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 py-0.5 pl-2 pr-1 text-xs font-medium text-secondary-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
          >
            {word}
            <button
              type="button"
              onClick={() => removeWord(word)}
              aria-label={`Remove ${word}`}
              className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        {dictionary.length === 0 ? (
          <span className="text-xs text-muted-foreground italic px-1 py-1.5">
            No words added yet.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null;
  return (
    <p id={id} role="alert" className="text-xs text-destructive break-words">
      {error}
    </p>
  );
}
