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
import { Tag, ToggleRow, SelectRow, DraftTextRow } from './ui/rows';
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
  ManagedLocalModelSnapshot,
} from '../../types/ipc';
import {
  getAppConfigDictationError,
  classifyFormatterEndpoint,
} from '../../shared/dictation-runtime';
import {
  SARVAM_LANGUAGES,
  SARVAM_MODELS,
  SARVAM_MODES,
  getSarvamSettingsErrors,
  sarvamLanguageCode,
} from '../../shared/sarvam';

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
const FIELD_ID_DICTATION_MODE = 'dictation-mode';
const FIELD_ID_FORMATTER_BASE_URL = 'formatter-base-url';
const FIELD_ID_FORMATTER_MODEL = 'formatter-model';
const FIELD_ID_FORMATTER_CONSENT = 'formatter-consent';

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
      { value: 'whisper-live-kit', label: 'WhisperLiveKit', description: 'Self-hosted Batch Dictation with health and protocol readiness checks.' },
    ],
  },
];

const PROVIDER_OPTIONS = PROVIDER_GROUPS.flatMap((group) => group.options);

function ProviderSelector({
  config,
  value,
  settingsIpc,
  error,
  onChange,
}: {
  config: AppConfig;
  value: TranscriptionProviderId;
  settingsIpc: SettingsSectionProps['settingsIpc'];
  error?: string;
  onChange: (value: string) => void;
}) {
  const labelId = useId();
  const detailId = useId();
  const errorId = useId();
  const credentialKind = providerCredentialKind(config, value);
  const [credentialResult, setCredentialResult] = useState<{
    kind: CredentialKind;
    ready: boolean;
  } | null>(null);

  useEffect(() => {
    let current = true;
    const kind = providerCredentialKind(config, value);
    if (!kind) return () => { current = false; };
    let revision = 0;
    const check = () => {
      const request = ++revision;
      settingsIpc.getCredentialStatus(kind)
        .then((status) => {
          if (current && request === revision) setCredentialResult({ kind, ready: status.available && status.exists });
        })
        .catch(() => {
          if (current && request === revision) setCredentialResult({ kind, ready: false });
        });
    };
    const off = settingsIpc.onCredentialChanged((credential) => {
      if (credential === kind) check();
    });
    check();
    return () => { current = false; off?.(); };
  }, [config, settingsIpc, value]);

  const credentialReady = credentialKind === null
    ? true
    : credentialResult?.kind === credentialKind
      ? credentialResult.ready
      : null;

  const selected = PROVIDER_OPTIONS.find((option) => option.value === value)!;
  const fieldsReady = providerFieldsReady(config, value);
  const readiness = !fieldsReady
    ? { label: 'Setup required', tone: 'warning' as const }
    : credentialReady === null
      ? { label: 'Checking setup', tone: 'neutral' as const }
      : credentialReady
        ? { label: 'Configured', tone: 'success' as const }
        : { label: 'Credential required', tone: 'warning' as const };

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
        <Tag tone={readiness.tone}>{readiness.label}</Tag>
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
  const { commit, fieldErrors } = persistence;
  const provider = config.transcription.activeProvider;
  const [dictationModeError, setDictationModeError] = useState<string | undefined>();
  // WhisperLiveKit readiness is owned here so the first-run checklist can only
  // mark the streaming step done from an actual readiness result.
  const [whisperLiveKitReadiness, setWhisperLiveKitReadiness] =
    useState<TranscriptionReadiness | null>(null);

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
  const dictation = config.dictation ?? { mode: 'batch' as const, formatter: null };
  const storedDictationModeError = getAppConfigDictationError({
    ...config,
    dictation,
  });

  const sarvam = config.transcription.providers.sarvam;
  const sarvamVerbatim = provider === 'sarvam' && sarvam.mode === 'verbatim' && config.task === 'transcribe';
  const languageOptions = provider === 'managed-local'
    ? WHISPER_LANGUAGES.map((option) => option.value === 'auto'
      ? { ...option, label: 'Automatic language detection' }
      : { ...option, disabled: true })
    : provider === 'google-cloud-speech-v2'
    ? WHISPER_LANGUAGES.map((option) => option.value === 'auto'
      ? { ...option, label: 'Auto-detect (not supported by Google synchronous recognition)', disabled: true }
      : option)
    : provider === 'sarvam'
    ? SARVAM_LANGUAGES
    : WHISPER_LANGUAGES;
  // Sarvam accepts plain codes like `hi` as `hi-IN`; show the mapped option instead of a blank select.
  const languageValue = provider === 'sarvam'
    ? sarvamLanguageCode(config.language) ?? config.language
    : config.language;
  const languageError = languageOptions.some((option) => option.value === languageValue)
    ? undefined
    : `${WHISPER_LANGUAGES.find((option) => option.value === config.language)?.label ?? config.language} is not supported by ${PROVIDER_OPTIONS.find((option) => option.value === provider)!.label}. Choose a supported language${provider === 'sarvam' ? ' or Auto-detect' : ''}.`;
  const dictionaryError = provider === 'sarvam' && sarvam.model === 'saaras:v4'
    ? getSarvamSettingsErrors(sarvam, 'auto', config.dictionary).join(' ') || undefined
    : undefined;

  const handleProviderChange = async (value: string) => {
    const nextProvider = value as TranscriptionProviderId;
    const nextTranscription = {
      ...config.transcription,
      activeProvider: nextProvider,
    };
    const combinationError = getAppConfigDictationError({
      ...config,
      dictation,
      transcription: nextTranscription,
    });
    if (combinationError) {
      setDictationModeError(combinationError);
      return;
    }
    setDictationModeError(undefined);
    await commit('transcription', nextTranscription, FIELD_ID_PROVIDER);
    if ((nextProvider === 'managed-local'
      || nextProvider === 'azure-speech'
      || nextProvider === 'google-cloud-speech-v2'
      || nextProvider === 'whisper-live-kit') && config.task === 'translate') {
      await commit('task', 'transcribe', FIELD_ID_TASK);
    }
    if (nextProvider === 'google-cloud-speech-v2' && config.language === 'auto') {
      await commit('language', 'en', FIELD_ID_LANGUAGE);
    }
  };

  const handleDictationModeChange = (value: string) => {
    const mode = value as DictationMode;
    const next = { ...dictation, mode };
    const error = getAppConfigDictationError({
      ...config,
      dictation: next,
    });
    if (error) {
      setDictationModeError(error);
      return;
    }
    setDictationModeError(undefined);
    void commit('dictation', next, FIELD_ID_DICTATION_MODE);
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
          whisperLiveKitReadiness={whisperLiveKitReadiness}
        />
      ) : null}
      <SettingsPanel>
        <SettingsPanelHeader title="Speech engine" />
        <SettingsCard>
        {provider === 'managed-local' ? (
          <>
            <ManagedLocalSection config={config} persistence={persistence} settingsIpc={settingsIpc} />
            <Disclosure label="Use a different provider" className="border-b border-border/50 py-3.5 last:border-b-0">
              <ProviderSelector
                config={config}
                value={provider}
                settingsIpc={settingsIpc}
                error={fieldErrors[FIELD_ID_PROVIDER]}
                onChange={handleProviderChange}
              />
            </Disclosure>
          </>
        ) : (
          <ProviderSelector
            config={config}
            value={provider}
            settingsIpc={settingsIpc}
            error={fieldErrors[FIELD_ID_PROVIDER]}
            onChange={handleProviderChange}
          />
        )}

        {provider === 'local-whisper-cpp' ? (
          <LocalWhisperSection config={config} persistence={persistence} settingsIpc={settingsIpc} />
        ) : null}

        {provider === 'openai' ? (
          <OpenAiSection config={config} persistence={persistence} settingsIpc={settingsIpc} />
        ) : null}

        {provider === 'sarvam' ? (
          <SarvamSection config={config} persistence={persistence} settingsIpc={settingsIpc} />
        ) : null}

        {provider === 'azure-speech' ? (
          <AzureSpeechSection config={config} persistence={persistence} settingsIpc={settingsIpc} />
        ) : null}

        {provider === 'google-cloud-speech-v2' ? (
          <GoogleCloudSpeechSection config={config} persistence={persistence} settingsIpc={settingsIpc} />
        ) : null}

        {provider === 'nvidia-speech-nim' ? (
          <NvidiaSpeechNimSection config={config} persistence={persistence} settingsIpc={settingsIpc} />
        ) : null}

        {provider === 'custom-open-ai-compatible' ? (
          <CustomOpenAiSection config={config} persistence={persistence} settingsIpc={settingsIpc} />
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

      <SettingsPanel>
        <SettingsPanelHeader title="Output" />
        <SettingsCard>
        <ToggleRow
          title="Clean transcription"
          description={sarvamVerbatim
            ? 'Off while Sarvam verbatim mode is selected, so filler words stay exactly as spoken. Your saved choice applies to other modes.'
            : 'Remove common filler words before dictation text is injected.'}
          checked={config.removeFillerWords && !sarvamVerbatim}
          disabled={sarvamVerbatim}
          errorId={useId()}
          error={fieldErrors[FIELD_ID_FILER]}
          onChange={(checked) => commit('removeFillerWords', checked, FIELD_ID_FILER)}
        />
        <SelectRow
          label="Dictation mode"
          value={dictation.mode}
          options={[
            { value: 'batch', label: 'Batch Dictation' },
            { value: 'live', label: 'Live Dictation (beta)' },
            { value: 'corrected', label: 'Corrected Dictation' },
          ]}
          description="Batch inserts text once you stop. Live and Corrected need a supported provider."
          errorId={useId()}
          error={dictationModeError ?? storedDictationModeError ?? fieldErrors[FIELD_ID_DICTATION_MODE]}
          onChange={handleDictationModeChange}
        />
        {dictation.mode === 'corrected' ? (
          <CorrectedDictationFormatterSection
            dictation={dictation}
            persistence={persistence}
            settingsIpc={settingsIpc}
            onDictationCommit={(next) => commit('dictation', next, FIELD_ID_DICTATION_MODE)}
          />
        ) : null}
        <SelectRow
          label="Task"
          value={config.task}
          options={[
            { value: 'transcribe', label: 'Transcribe spoken language' },
            {
              value: 'translate',
              label: provider === 'whisper-live-kit'
                ? 'Translate speech to English (not supported by WhisperLiveKit)'
                : provider === 'azure-speech'
                  ? 'Translate speech to English (not supported by Azure Fast Transcription)'
                  : provider === 'google-cloud-speech-v2'
                    ? 'Translate speech to English (not supported by Google synchronous recognition)'
                    : provider === 'sarvam'
                      ? 'Translate speech to English (Sarvam translate mode)'
                      : 'Translate speech to English',
              disabled: provider === 'managed-local' || provider === 'azure-speech' || provider === 'google-cloud-speech-v2' || provider === 'whisper-live-kit',
            },
          ]}
          description={provider === 'managed-local'
            ? 'Managed Local supports transcription. Corrected Dictation can format its finalized local transcript.'
            : provider === 'whisper-live-kit'
            ? 'WhisperLiveKit batch transcription supports transcription only. Shuddhalekhan does not send translation requests.'
            : provider === 'azure-speech'
              ? 'Azure Fast Transcription supports transcription only. Translation is not sent to another service.'
              : provider === 'google-cloud-speech-v2'
                ? 'Google synchronous recognition transcribes only. Shuddhalekhan does not invoke Google Translate.'
                : provider === 'sarvam'
                  ? 'Translate always returns English text and replaces the Sarvam output mode.'
                  : undefined}
          errorId={useId()}
          error={fieldErrors[FIELD_ID_TASK]}
          onChange={(value) => commit('task', value as AppConfig['task'], FIELD_ID_TASK)}
        />
        <SelectRow
          label="Spoken language"
          value={languageValue}
          options={languageOptions}
          description={provider === 'managed-local'
            ? 'The installed model detects its supported European languages automatically.'
            : provider === 'google-cloud-speech-v2'
            ? 'Choose an explicit language. Shuddhalekhan does not substitute the Windows language.'
            : provider === 'sarvam'
            ? sarvam.model === 'saaras:v4'
              ? 'Sarvam supports 22 Indian languages and English, including global English accents on Saaras v4.'
              : 'Sarvam supports 22 Indian languages and Indian English.'
            : undefined}
          errorId={useId()}
          error={fieldErrors[FIELD_ID_LANGUAGE] ?? languageError}
          onChange={(value) => commit('language', provider === 'sarvam' ? value.split('-')[0] : value, FIELD_ID_LANGUAGE)}
        />
        <DictionaryRow
          dictionary={config.dictionary}
          disabled={provider === 'managed-local' || provider === 'whisper-live-kit' || (provider === 'sarvam' && sarvam.model === 'saaras:v3')}
          description={provider === 'managed-local'
            ? 'Managed Local does not support dictionary hints. Saved words stay available for other providers.'
            : provider === 'whisper-live-kit'
              ? 'WhisperLiveKit does not support dictionary hints. Saved words stay available for other providers.'
            : provider === 'sarvam'
              ? sarvam.model === 'saaras:v3'
                ? 'Saaras v3 does not support key terms, so your dictionary is not sent. Saved words stay available for Saaras v4 and other providers.'
                : 'Sent to Saaras v4 as key terms: up to 50 names, brands, or technical terms. Press Enter to add.'
            : undefined}
          error={fieldErrors[FIELD_ID_DICTIONARY] ?? dictionaryError}
          onChange={(next) => commit('dictionary', next, FIELD_ID_DICTIONARY)}
        />
        </SettingsCard>
      </SettingsPanel>
      <PrivacyNote provider={provider} />
    </div>
  );
}

function ManagedLocalSection({ config, persistence, settingsIpc }: Pick<SettingsSectionProps, 'config' | 'persistence' | 'settingsIpc'>) {
  const [snapshot, setSnapshot] = useState<ManagedLocalModelSnapshot | null>(null);
  const [error, setError] = useState('');
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

  useEffect(() => {
    void settingsIpc.getManagedLocalModel().then(setSnapshot).catch(() => {
      setError('Could not check the local speech model.');
    });
    const off = settingsIpc.onManagedLocalModelStateChanged((state) => {
      setSnapshot((current) => current ? { ...current, state } : current);
    });
    return () => off?.();
  }, [settingsIpc]);

  const install = async () => {
    setError('');
    try {
      setSnapshot(await settingsIpc.installManagedLocalModel());
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : 'Model installation failed.');
      void settingsIpc.getManagedLocalModel().then(setSnapshot);
    }
  };

  const remove = async () => {
    setError('');
    try {
      setSnapshot(await settingsIpc.deleteManagedLocalModel());
    } catch {
      setError('Could not delete the local speech model. Retry.');
    }
  };

  return (
    <div className="border-b border-border/50 py-3.5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <p className="flex items-center gap-2 text-sm font-medium">
            Local speech model
            {snapshot?.state.kind === 'ready' ? <Tag tone="success">Ready offline</Tag> : null}
          </p>
          {snapshot ? (
            <p className="text-xs text-muted-foreground">
              {snapshot.model.name} · {Math.round(snapshot.model.downloadBytes / 1_000_000)} MB download · {snapshot.model.languages.length} languages
            </p>
          ) : <p className="text-xs text-muted-foreground">Checking status…</p>}
        </div>
        {snapshot?.state.kind === 'ready' ? (
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => void remove()}>Delete model</Button>
        ) : snapshot?.state.kind === 'downloading' || snapshot?.state.kind === 'installing' ? null : (
          <Button size="sm" onClick={() => void install()}>
            {snapshot?.state.kind === 'error'
              ? snapshot.state.action === 'resume' ? 'Resume' : snapshot.state.action === 'repair' ? 'Repair' : 'Retry'
              : 'Install'}
          </Button>
        )}
      </div>
      {snapshot?.state.kind === 'downloading' ? (
        <p className="mt-3 text-xs" role="status">Downloading… {Math.round(snapshot.state.downloadedBytes / snapshot.state.totalBytes * 100)}%</p>
      ) : null}
      {snapshot?.state.kind === 'installing' ? <p className="mt-3 text-xs" role="status">Verifying and installing…</p> : null}
      {snapshot?.state.kind === 'error' ? <p className="mt-3 text-xs text-destructive" role="alert">{snapshot.state.message}</p> : null}
      {error ? <p className="mt-3 text-xs text-destructive" role="alert">{error}</p> : null}
      {snapshot ? (
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
              More threads can finish sooner but use more CPU and battery. Quality is unchanged.
              Default is {snapshot.inference.defaultThreads}; changes apply to the next transcription.
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
  dictation,
  persistence,
  settingsIpc,
  onDictationCommit,
}: {
  dictation: AppConfig['dictation'];
  persistence: import('./use-settings-persistence').SettingsPersistence;
  settingsIpc: import('./settings-ipc').SettingsIpc;
  onDictationCommit: (next: AppConfig['dictation']) => void;
}) {
  const { fieldErrors, clearFieldError } = persistence;
  const formatter = defaultFormatterProfile(dictation);
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

  const updateFormatter = (patch: Partial<DictationFormatterProfile>) => {
    const nextFormatter = { ...formatter, ...patch };
    onDictationCommit({ ...dictation, formatter: nextFormatter });
  };

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
        onCommit={(baseUrl) => updateFormatter({ baseUrl })}
        clearError={() => clearFieldError(FIELD_ID_FORMATTER_BASE_URL)}
      />
      <DraftTextRow
        label="Formatter model"
        value={formatter.model}
        placeholder="formatter"
        errorId={formatterModelErrorId}
        error={fieldErrors[FIELD_ID_FORMATTER_MODEL]}
        onCommit={(model) => updateFormatter({ model })}
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
        onChange={(value) => updateFormatter({
          apiKeySource: value as FormatterApiKeySource,
          apiKeyEnvVar: value === 'stored' ? '' : formatter.apiKeyEnvVar,
        })}
      />
      {apiKeySource === 'environment' ? (
        <DraftTextRow
          label="Formatter API key environment variable"
          value={formatter.apiKeyEnvVar}
          placeholder="OPENAI_API_KEY"
          warning={apiKeyWarning}
          errorId={formatterApiKeyEnvVarErrorId}
          onCommit={(apiKeyEnvVar) => updateFormatter({ apiKeyEnvVar })}
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
        onChange={(checked) => updateFormatter({ processingConsent: checked })}
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

function OpenAiSection({ config, persistence, settingsIpc }: Props) {
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
        onCommit={(value) => commit('transcription', {
          ...config.transcription,
          providers: { ...config.transcription.providers, openai: { ...openai, model: value.trim() } },
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

function SarvamSection({ config, persistence, settingsIpc }: Props) {
  const { commit, fieldErrors } = persistence;
  const sarvam = config.transcription.providers.sarvam;
  const modeErrorId = useId();
  const save = (next: SarvamConfig, field: string) => commit('transcription', {
    ...config.transcription,
    providers: { ...config.transcription.providers, sarvam: next },
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

function NvidiaSpeechNimSection({ config, persistence, settingsIpc }: Props) {
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
      <Disclosure label="Advanced model capabilities" className="border-b border-border/50 py-3.5 last:border-b-0 text-sm">
        <div className="mt-2">
          <ToggleRow title="Automatic language detection" description="Enable only if the selected NIM model declares support." checked={nim.supportsAutomaticLanguageDetection} errorId={useId()} onChange={(checked) => save({ ...nim, supportsAutomaticLanguageDetection: checked }, 'nvidia-auto-language')} />
          <ToggleRow title="Translation" description="Enable only if the selected NIM model and endpoint support translation." checked={nim.supportsTranslation} errorId={useId()} onChange={(checked) => save({ ...nim, supportsTranslation: checked }, 'nvidia-translation')} />
          <ToggleRow title="Dictionary hints" description="Send personal dictionary terms as an OpenAI-compatible prompt." checked={nim.supportsDictionaryHints} errorId={useId()} onChange={(checked) => save({ ...nim, supportsDictionaryHints: checked }, 'nvidia-dictionary')} />
        </div>
      </Disclosure>
      <p role="note" className="border-b border-border/50 py-3.5 last:border-b-0 text-xs text-muted-foreground">
        This endpoint is user-hosted, not an NVIDIA managed cloud service. Speech NIM typically requires a supported GPU server or WSL2 deployment.
      </p>
    </>
  );
}

function CustomOpenAiSection({ config, persistence, settingsIpc }: Props) {
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
        WhisperLiveKit is a user-hosted service. Batch Dictation sends audio to its REST endpoint; readiness opens a short-lived handshake socket and keeps no idle ASR connection.
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

function PrivacyNote({ provider }: { provider: TranscriptionProviderId }) {
  return (
    <p
      role="note"
      aria-label="Transcription privacy note"
      className="-mt-4 px-1 text-xs leading-5 text-muted-foreground/80"
    >
      {PRIVACY_MESSAGES[provider]}
    </p>
  );
}

interface DictionaryRowProps {
  dictionary: string[];
  disabled?: boolean;
  description?: string;
  error?: string;
  onChange: (next: string[]) => void;
}

function DictionaryRow({ dictionary, disabled = false, description, error, onChange }: DictionaryRowProps) {
  const [inputValue, setInputValue] = useState('');
  const errorId = useId();

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      const newWord = inputValue.trim();
      if (!dictionary.includes(newWord)) {
        onChange([...dictionary, newWord]);
      }
      setInputValue('');
    }
  };

  const removeWord = (wordToRemove: string) => {
    onChange(dictionary.filter((word) => word !== wordToRemove));
  };

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
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a word and press Enter…"
        aria-label="Add dictionary word"
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      <FieldError id={errorId} error={error} />
      <div className="flex flex-wrap gap-2">
        {dictionary.map((word) => (
          <span
            key={word}
            className="group inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 py-0.5 pl-2 pr-1 text-xs font-medium text-secondary-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
          >
            {word}
            <button
              type="button"
              disabled={disabled}
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
