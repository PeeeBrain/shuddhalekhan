import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { X } from 'lucide-react';
import { SectionHeader } from './ui/SectionHeader';
import { Tag, ToggleRow, SelectRow, DraftTextRow } from './ui/rows';
import { SetupChecklist } from './SetupChecklist';
import { CredentialControl } from './ui/CredentialControl';
import { WHISPER_LANGUAGES } from './settings-model';
import type { SettingsSectionProps } from './settings-section-props';
import type { AppConfig, TranscriptionProviderId } from '../../types/ipc';

type TestState = 'idle' | 'checking' | 'success' | 'failed';

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

const PROVIDER_OPTIONS: Array<{ value: TranscriptionProviderId; label: string }> = [
  { value: 'local-whisper-cpp', label: 'Local whisper.cpp' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'azure-speech', label: 'Microsoft Azure Speech' },
  { value: 'google-cloud-speech-v2', label: 'Google Cloud Speech-to-Text v2' },
  { value: 'nvidia-speech-nim', label: 'NVIDIA Speech NIM' },
  { value: 'custom-open-ai-compatible', label: 'Custom OpenAI-compatible' },
];

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

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

  const handleProviderChange = async (value: string) => {
    const nextProvider = value as TranscriptionProviderId;
    await commit('transcription', {
      ...config.transcription,
      activeProvider: nextProvider,
    }, FIELD_ID_PROVIDER);
    if ((nextProvider === 'azure-speech' || nextProvider === 'google-cloud-speech-v2') && config.task === 'translate') {
      await commit('task', 'transcribe', FIELD_ID_TASK);
    }
    if (nextProvider === 'google-cloud-speech-v2' && config.language === 'auto') {
      await commit('language', 'en', FIELD_ID_LANGUAGE);
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Transcription"
        description="Configure where recordings are transcribed and how language is handled."
      />
      {!config.setupChecklistDismissed ? (
        <SetupChecklist config={config} onNavigate={onNavigate} persistence={persistence} />
      ) : null}
      <div className="rounded-lg border border-border/60 bg-card px-6">
        <SelectRow
          label="Provider"
          value={provider}
          options={PROVIDER_OPTIONS}
          errorId={useId()}
          onChange={handleProviderChange}
        />

        {provider === 'local-whisper-cpp' ? (
          <LocalWhisperSection config={config} persistence={persistence} settingsIpc={settingsIpc} />
        ) : null}

        {provider === 'openai' ? (
          <OpenAiSection config={config} persistence={persistence} settingsIpc={settingsIpc} />
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

        <ToggleRow
          title="Clean transcription"
          description="Remove common filler words before dictation text is injected."
          checked={config.removeFillerWords}
          errorId={useId()}
          error={fieldErrors[FIELD_ID_FILER]}
          onChange={(checked) => commit('removeFillerWords', checked, FIELD_ID_FILER)}
        />
        <SelectRow
          label="Mode"
          value={config.task}
          options={[
            { value: 'transcribe', label: 'Transcribe spoken language' },
            {
              value: 'translate',
              label: provider === 'azure-speech'
                ? 'Translate speech to English (not supported by Azure Fast Transcription)'
                : provider === 'google-cloud-speech-v2'
                  ? 'Translate speech to English (not supported by Google synchronous recognition)'
                  : 'Translate speech to English',
              disabled: provider === 'azure-speech' || provider === 'google-cloud-speech-v2',
            },
          ]}
          description={provider === 'azure-speech'
            ? 'Azure Fast Transcription supports transcription only. Translation is not sent to another service.'
            : provider === 'google-cloud-speech-v2'
              ? 'Google synchronous recognition transcribes only. Shuddhalekhan does not invoke Google Translate.'
              : undefined}
          errorId={useId()}
          error={fieldErrors[FIELD_ID_TASK]}
          onChange={(value) => commit('task', value as AppConfig['task'], FIELD_ID_TASK)}
        />
        <SelectRow
          label="Spoken language"
          value={config.language}
          options={provider === 'google-cloud-speech-v2'
            ? WHISPER_LANGUAGES.map((option) => option.value === 'auto'
              ? { ...option, label: 'Auto-detect (not supported by Google synchronous recognition)', disabled: true }
              : option)
            : WHISPER_LANGUAGES}
          description={provider === 'google-cloud-speech-v2'
            ? 'Choose an explicit language. Shuddhalekhan does not substitute the Windows language.'
            : undefined}
          errorId={useId()}
          error={fieldErrors[FIELD_ID_LANGUAGE]}
          onChange={(value) => commit('language', value, FIELD_ID_LANGUAGE)}
        />
        <DictionaryRow
          dictionary={config.dictionary}
          error={fieldErrors[FIELD_ID_DICTIONARY]}
          onChange={(next) => commit('dictionary', next, FIELD_ID_DICTIONARY)}
        />
      </div>
      <PrivacyNote provider={provider} />
    </div>
  );
}

interface Props {
  config: AppConfig;
  persistence: import('./use-settings-persistence').SettingsPersistence;
  settingsIpc: import('./settings-ipc').SettingsIpc;
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

  const validate = (value: string): string | null => {
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
  };

  const testConnection = async () => {
    const candidate = draft;
    const error = validate(candidate);
    setValidationError(error);
    if (error) return;
    if (candidate !== localEndpoint) {
      await commit('transcription', {
        ...config.transcription,
        providers: {
          ...config.transcription.providers,
          localWhisperCpp: { endpoint: candidate },
        },
      }, 'whisper-url');
    }
    setTestState('checking');
    const reachable = await settingsIpc.checkTranscriptionServer();
    setTestState(reachable ? 'success' : 'failed');
  };

  const fieldError = validationError ?? fieldErrors['whisper-url'];

  return (
    <div className="space-y-2 border-b border-border/70 py-5">
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
          clearFieldError('whisper-url');
          setTestState('idle');
        }}
        onBlur={() => {
          if (draft === localEndpoint) return;
          const error = validate(draft);
          setValidationError(error);
          if (!error) {
            commit('transcription', {
              ...config.transcription,
              providers: {
                ...config.transcription.providers,
                localWhisperCpp: { endpoint: draft },
              },
            }, 'whisper-url');
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
          disabled={testState === 'checking' || validate(draft) !== null}
          onClick={testConnection}
        >
          {testState === 'checking' ? 'Checking...' : 'Check server'}
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

  const validateUrl = (value: string): string | null => {
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
  };

  const validateModel = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return 'Model name is required.';
    if (trimmed.length > 128) return 'Model name is too long (max 128 characters).';
    for (let i = 0; i < trimmed.length; i++) {
      const code = trimmed.charCodeAt(i);
      if (code < 32 || code === 127) return 'Model name contains control characters.';
    }
    return null;
  };

  return (
    <>
      <DraftTextRow
        label="Base URL"
        value={openai.baseUrl}
        placeholder="https://api.openai.com/v1"
        description="The /audio/transcriptions endpoint is appended automatically."
        errorId={useId()}
        error={fieldErrors[FIELD_ID_OPENAI_BASE_URL]}
        validate={validateUrl}
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
        validate={validateModel}
        onCommit={(value) => commit('transcription', {
          ...config.transcription,
          providers: { ...config.transcription.providers, openai: { ...openai, model: value.trim() } },
        }, FIELD_ID_OPENAI_MODEL)}
        clearError={() => persistence.clearFieldError(FIELD_ID_OPENAI_MODEL)}
      />
      <div className="border-b border-border/70 py-5">
        <CredentialControl
          credential="openai-api-key"
          label="OpenAI API key"
          settingsIpc={settingsIpc}
        />
      </div>
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
      <div className="border-b border-border/70 py-5">
        <CredentialControl
          credential="azure-speech-key"
          label="Azure Speech key"
          settingsIpc={settingsIpc}
        />
      </div>
      <p role="note" className="border-b border-border/70 py-4 text-xs text-muted-foreground">
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
  const validateSlug = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return 'This field is required.';
    if (trimmed.length > 128) return 'Value is too long (max 128 characters).';
    return hasControlCharacters(trimmed) ? 'Value contains control characters.' : null;
  };

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
        errorId={useId()} error={fieldErrors[FIELD_ID_GOOGLE_MODEL]} validate={validateSlug}
        onCommit={(value) => save({ ...google, model: value.trim() }, FIELD_ID_GOOGLE_MODEL)}
        clearError={() => persistence.clearFieldError(FIELD_ID_GOOGLE_MODEL)} />
      {google.credentialSource === 'service-account' ? (
        <CredentialControl credential="google-service-account" label="Service-account JSON document" settingsIpc={settingsIpc} documentImport />
      ) : (
        <p role="note" className="border-b border-border/70 py-4 text-xs text-muted-foreground">
          Application Default Credentials are read by the main process from GOOGLE_APPLICATION_CREDENTIALS or the gcloud ADC file.
        </p>
      )}
      <details className="border-b border-border/70 py-4 text-sm">
        <summary className="cursor-pointer font-medium">Advanced</summary>
        <div className="mt-3">
          <SelectRow label="Credential source" value={google.credentialSource} errorId={useId()}
            options={[{ value: 'service-account', label: 'Imported service-account document' }, { value: 'adc', label: 'Application Default Credentials' }]}
            onChange={(value) => save({ ...google, credentialSource: value as typeof google.credentialSource }, 'google-credential-source')} />
        </div>
      </details>
      <p role="note" className="border-b border-border/70 py-4 text-xs text-muted-foreground">
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
  const validateModel = (value: string) => !value.trim() ? 'Model name is required.'
    : value.trim().length > 128 ? 'Model name is too long (max 128 characters).'
      : hasControlCharacters(value) ? 'Model name contains control characters.' : null;
  const validateEndpoint = (value: string) => {
    try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' ? null : 'Endpoint must use HTTP or HTTPS.'; }
    catch { return 'Enter a valid NVIDIA Speech NIM transcription endpoint.'; }
  };

  return (
    <>
      <DraftTextRow label="Endpoint" value={nim.endpoint} placeholder="http://localhost:9000/v1/audio/transcriptions"
        description="Complete OpenAI-compatible offline transcription endpoint on your NIM deployment."
        errorId={useId()} error={fieldErrors[FIELD_ID_NVIDIA_ENDPOINT]} validate={validateEndpoint}
        onCommit={(value) => save({ ...nim, endpoint: value.trim() }, FIELD_ID_NVIDIA_ENDPOINT)}
        clearError={() => persistence.clearFieldError(FIELD_ID_NVIDIA_ENDPOINT)} />
      <DraftTextRow label="Model" value={nim.model} placeholder="nvidia/parakeet-ctc-1.1b-asr"
        description="Free-form model slug exposed by your NIM server."
        errorId={useId()} error={fieldErrors[FIELD_ID_NVIDIA_MODEL]} validate={validateModel}
        onCommit={(value) => save({ ...nim, model: value.trim() }, FIELD_ID_NVIDIA_MODEL)}
        clearError={() => persistence.clearFieldError(FIELD_ID_NVIDIA_MODEL)} />
      <SelectRow label="Authentication" value={nim.auth} options={AUTH_OPTIONS} errorId={useId()}
        onChange={(value) => save({ ...nim, auth: value as typeof nim.auth, headerName: value === 'header' ? nim.headerName : '' }, 'nvidia-auth')} />
      {nim.auth === 'bearer' ? <CredentialControl credential="nvidia-nim-bearer" label="Bearer token" settingsIpc={settingsIpc} /> : null}
      {nim.auth === 'header' ? (
        <>
          <DraftTextRow label="Header name" value={nim.headerName} placeholder="X-API-Key"
            description="Secret header used by your reverse proxy." errorId={headerErrorId} error={fieldErrors['nvidia-header-name']}
            validate={(value) => /^[!#$%&'*+\-.^_`|~\w]+$/.test(value.trim()) ? null : 'Header name contains invalid characters.'}
            onCommit={(value) => save({ ...nim, headerName: value.trim() }, 'nvidia-header-name')}
            clearError={() => persistence.clearFieldError('nvidia-header-name')} />
          <CredentialControl credential="nvidia-nim-header" label="Secret header value" settingsIpc={settingsIpc} />
        </>
      ) : null}
      {nim.auth === 'none' ? <CheckServerTest provider="nvidia-speech-nim" settingsIpc={settingsIpc} testState={testState} setTestState={setTestState} /> : null}
      <details className="border-b border-border/70 py-4 text-sm">
        <summary className="cursor-pointer font-medium">Advanced model capabilities</summary>
        <div className="mt-2">
          <ToggleRow title="Automatic language detection" description="Enable only if the selected NIM model declares support." checked={nim.supportsAutomaticLanguageDetection} errorId={useId()} onChange={(checked) => save({ ...nim, supportsAutomaticLanguageDetection: checked }, 'nvidia-auto-language')} />
          <ToggleRow title="Translation" description="Enable only if the selected NIM model and endpoint support translation." checked={nim.supportsTranslation} errorId={useId()} onChange={(checked) => save({ ...nim, supportsTranslation: checked }, 'nvidia-translation')} />
          <ToggleRow title="Dictionary hints" description="Send personal dictionary terms as an OpenAI-compatible prompt." checked={nim.supportsDictionaryHints} errorId={useId()} onChange={(checked) => save({ ...nim, supportsDictionaryHints: checked }, 'nvidia-dictionary')} />
        </div>
      </details>
      <p role="note" className="border-b border-border/70 py-4 text-xs text-muted-foreground">
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

  const validateEndpoint = (value: string): string | null => {
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
  };

  const handleAuthChange = (value: string) => {
    commit('transcription', {
      ...config.transcription,
      providers: {
        ...config.transcription.providers,
        customOpenAiCompatible: { ...custom, auth: value as 'none' | 'bearer' | 'header', headerName: value !== 'header' ? '' : custom.headerName },
      },
    }, 'custom-auth');
  };

  const validateModel = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return 'Model name is required.';
    if (trimmed.length > 128) return 'Model name is too long (max 128 characters).';
    for (let i = 0; i < trimmed.length; i++) {
      const code = trimmed.charCodeAt(i);
      if (code < 32 || code === 127) return 'Model name contains control characters.';
    }
    return null;
  };

  const validateHeaderName = (value: string): string | null => {
    if (!value.trim()) return 'Header name is required.';
    if (!/^[!#$%&'*+\-.^_`|~\w]+$/.test(value.trim())) return 'Header name contains invalid characters.';
    return null;
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
        validate={validateEndpoint}
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
        error={fieldErrors['custom-model']}
        validate={validateModel}
        onCommit={(value) => commit('transcription', {
          ...config.transcription,
          providers: { ...config.transcription.providers, customOpenAiCompatible: { ...custom, model: value.trim() } },
        }, 'custom-model')}
        clearError={() => persistence.clearFieldError('custom-model')}
      />
      <SelectRow
        label="Authentication"
        value={custom.auth}
        options={AUTH_OPTIONS}
        errorId={authErrorId}
        onChange={handleAuthChange}
      />
      {custom.auth === 'bearer' ? (
        <div className="border-b border-border/70 py-5">
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
          <div className="border-b border-border/70 py-5">
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
    <div className="flex items-center gap-3 border-b border-border/70 py-5">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={testState === 'checking'}
        onClick={check}
        aria-describedby={testState !== 'idle' ? labelId : undefined}
      >
        {testState === 'checking' ? 'Checking...' : 'Check connectivity'}
      </Button>
      {testState === 'success' ? (
        <span id={labelId}><Tag tone="success">Reachable</Tag></span>
      ) : null}
      {testState === 'failed' ? (
        <span id={labelId}>
          <Tag tone="error">Unreachable</Tag>
        </span>
      ) : null}
    </div>
  );
}

function PrivacyNote({ provider }: { provider: TranscriptionProviderId }) {
  const messages: Record<TranscriptionProviderId, string> = {
    'local-whisper-cpp': 'Recorded audio is sent to the configured local endpoint for transcription.',
    'openai': 'Recorded audio is sent to OpenAI for transcription. Review OpenAI\'s data handling policies.',
    'azure-speech': 'Recorded audio is sent to Microsoft Azure Speech for transcription. Review Microsoft\'s data handling policies.',
    'google-cloud-speech-v2': 'Recorded audio is sent to Google Cloud Speech-to-Text for transcription. Review Google Cloud data handling policies.',
    'nvidia-speech-nim': 'Recorded audio is sent to the configured NVIDIA Speech NIM endpoint for transcription.',
    'custom-open-ai-compatible': 'Recorded audio is sent to the configured custom endpoint for transcription.',
  };

  return (
    <p
      role="note"
      aria-label="Transcription privacy note"
      className="px-6 text-xs text-muted-foreground"
    >
      {messages[provider]}
    </p>
  );
}

interface DictionaryRowProps {
  dictionary: string[];
  error?: string;
  onChange: (next: string[]) => void;
}

function DictionaryRow({ dictionary, error, onChange }: DictionaryRowProps) {
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
    <div className="space-y-3 border-b border-border/70 py-5">
      <div className="space-y-1">
        <Label className="text-sm font-medium">Personal dictionary</Label>
        <p className="text-xs text-muted-foreground">
          Add specific names, technical terms, or acronyms to help transcription. Press Enter to add.
        </p>
      </div>
      <Input
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a word and press Enter..."
        aria-label="Add dictionary word"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      <FieldError id={errorId} error={error} />
      <div className="flex flex-wrap gap-2">
        {dictionary.map((word) => (
          <span
            key={word}
            className="group inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-sm font-medium text-secondary-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
          >
            {word}
            <button
              type="button"
              onClick={() => removeWord(word)}
              aria-label={`Remove ${word}`}
              className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
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
