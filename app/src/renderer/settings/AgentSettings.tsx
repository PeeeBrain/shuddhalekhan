import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SectionHeader, SettingsCard, SettingsPanel, SettingsPanelHeader } from './ui/SectionHeader';
import { ToggleRow, DraftTextRow, SelectRow, ReadOnlyRow, Tag, type TagTone } from './ui/rows';
import { CredentialControl } from './ui/CredentialControl';
import { Disclosure } from './ui/Disclosure';
import { looksLikeRawApiKey } from './settings-model';
import {
  getAgentProviderRequestUrl,
  isLoopbackProviderUrl,
  normalizeAgentProvider,
  type ResolvedAgentProvider,
} from '../../shared/agent-provider';
import type { SettingsSectionProps } from './settings-section-props';
import type { SettingsIpc } from './settings-ipc';
import type {
  AgentProviderCheck,
  AgentProviderConfig,
  AgentProviderIssue,
  AgentProviderKind,
  AgentProviderTestResult,
  AgentProviderValidation,
  AppConfig,
  ChatGptAccountStatus,
  ChatGptModel,
} from '../../types/ipc';

const FIELD_ID_ENABLED = 'agent-enabled';
const FIELD_ID_KIND = 'agent-kind';
const FIELD_ID_BASE_URL = 'agent-base-url';
const FIELD_ID_MODEL = 'agent-model';
const FIELD_ID_API_MODE = 'agent-api-mode';
const FIELD_ID_REASONING = 'agent-reasoning';
const FIELD_ID_INSECURE_HTTP = 'agent-insecure-http';
const FIELD_ID_CACHE_BREAKPOINTS = 'agent-cache-breakpoints';
const FIELD_ID_AUTH = 'agent-auth';
const FIELD_ID_APIKEY = 'agent-api-key';
const FIELD_ID_APIKEY_SOURCE = 'agent-api-key-source';
const FIELD_ID_CHATGPT_MODEL = 'agent-chatgpt-model';
const DIAGNOSTIC_DETAIL_LIMIT = 4000;
const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

/** Recommended defaults applied when the user picks a provider kind. */
const PROVIDER_KINDS: Record<AgentProviderKind, {
  label: string;
  baseUrl: string;
  placeholder: string;
  keyPlaceholder: string;
  auth?: ResolvedAgentProvider['auth'];
  description?: string;
}> = {
  chatgpt: {
    label: 'ChatGPT plan',
    baseUrl: 'https://api.openai.com/v1',
    placeholder: '',
    keyPlaceholder: '',
    auth: 'bearer',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    placeholder: 'https://api.openai.com/v1',
    keyPlaceholder: 'OPENAI_API_KEY',
    auth: 'bearer',
  },
  'azure-openai': {
    label: 'Azure OpenAI (v1)',
    baseUrl: '',
    placeholder: 'https://my-resource.openai.azure.com/openai/v1',
    keyPlaceholder: 'AZURE_OPENAI_API_KEY',
    auth: 'api-key',
    description: 'Use your resource’s /openai/v1 base URL. No dated api-version is needed.',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    placeholder: 'https://openrouter.ai/api/v1',
    keyPlaceholder: 'OPENROUTER_API_KEY',
    auth: 'bearer',
  },
  'openai-compatible': {
    label: 'Local or custom (OpenAI-compatible)',
    baseUrl: '',
    placeholder: 'http://localhost:11434/v1',
    keyPlaceholder: 'Optional for local servers',
    description: 'Ollama, LM Studio, vLLM, or any server with an OpenAI-compatible Chat Completions API.',
  },
};

const PRESET_URLS = new Set(Object.values(PROVIDER_KINDS).map((kind) => kind.baseUrl).filter(Boolean));

const REASONING_OPTIONS = [
  { value: 'default', label: 'Provider default' },
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

const CHECK_TONE: Record<AgentProviderCheck['status'], TagTone> = {
  passed: 'success',
  failed: 'error',
  'not-checked': 'neutral',
  inconclusive: 'warning',
};

const CHECK_LABEL: Record<AgentProviderCheck['status'], string> = {
  passed: 'Passed',
  failed: 'Failed',
  'not-checked': 'Not checked',
  inconclusive: 'Inconclusive',
};

/** Results are stamped with the provider object and invalidation count they were made for; stale ones never render. */
interface Stamp {
  provider: AgentProviderConfig;
  invalidation: number;
}

interface ValidationState extends Stamp {
  value: AgentProviderValidation | null;
}

interface TestRun extends Stamp {
  result?: AgentProviderTestResult;
  error?: string;
}

export function AgentSettings({ config, persistence, settingsIpc }: SettingsSectionProps) {
  const { commit, fieldErrors, clearFieldError } = persistence;
  const agent = config.agent;
  const provider = normalizeAgentProvider(agent.provider);
  const preset = PROVIDER_KINDS[provider.kind];
  const isChatGpt = provider.kind === 'chatgpt';
  const chatGpt = useChatGptAccount(settingsIpc, isChatGpt);
  const [pendingDisable, setPendingDisable] = useState(false);
  const [invalidation, setInvalidation] = useState(0);
  const [validation, setValidation] = useState<ValidationState | null>(null);
  const [testRun, setTestRun] = useState<TestRun | null>(null);
  const pendingTestRef = useRef<TestRun | null>(null);
  const enabledErrorId = useId();
  const kindErrorId = useId();
  const baseUrlErrorId = useId();
  const modelErrorId = useId();
  const apiModeErrorId = useId();
  const reasoningErrorId = useId();
  const insecureHttpErrorId = useId();
  const cacheBreakpointsErrorId = useId();
  const authErrorId = useId();
  const apiKeySourceErrorId = useId();
  const apiKeyEnvVarErrorId = useId();

  useEffect(
    () => settingsIpc.onAgentProviderInvalidated(() => setInvalidation((count) => count + 1)),
    [settingsIpc],
  );

  // Local checks only: no network. Re-run whenever the saved provider or its credential changes.
  useEffect(() => {
    let active = true;
    const stamp = { provider: agent.provider, invalidation };
    settingsIpc.validateAgentProvider(agent.provider)
      .then((value) => {
        if (active) setValidation({ ...stamp, value });
      })
      .catch(() => {
        if (active) setValidation({ ...stamp, value: null });
      });
    return () => {
      active = false;
    };
  }, [agent.provider, invalidation, settingsIpc]);

  // A provider or credential change, disabling Agent Mode, or leaving the page abandons the model test and its result.
  useEffect(() => () => {
    setTestRun(null);
    if (!pendingTestRef.current) return;
    pendingTestRef.current = null;
    settingsIpc.cancelAgentProviderTest().catch(() => undefined);
  }, [agent.enabled, agent.provider, invalidation, settingsIpc]);

  const isCurrent = (stamp: Stamp | null) =>
    stamp !== null && stamp.provider === agent.provider && stamp.invalidation === invalidation;
  const currentValidation = isCurrent(validation) ? validation : null;
  const currentTest = agent.enabled && isCurrent(testRun) ? testRun : null;
  const testing = currentTest !== null && !currentTest.result && !currentTest.error;
  const issues = currentValidation?.value?.issues ?? [];
  const credentials = currentValidation?.value?.credentials;
  const issueFor = (field: AgentProviderIssue['field']) =>
    issues.find((issue) => issue.field === field)?.message;

  const testBlockedReason = !agent.enabled
    ? 'Turn on Agent Mode to test the model. Local checks run while it is off.'
    : !currentValidation
      ? 'Checking settings…'
      : !currentValidation.value
        ? 'Could not check these settings.'
        : issues.length > 0
          ? 'Fix the settings issues before testing.'
          : credentials === 'missing'
            ? isChatGpt ? 'Sign in with ChatGPT before testing.' : 'Add an API key before testing.'
            : null;

  const updateAgent = (next: AppConfig['agent']) =>
    commit('agent', next, FIELD_ID_ENABLED);

  const commitProvider = (patch: Partial<ResolvedAgentProvider>, fieldId: string) =>
    commit('agent', { ...agent, provider: { ...provider, ...patch } }, fieldId);

  const toggleEnabled = (checked: boolean) => {
    if (!checked && agent.enabled) {
      setPendingDisable(true);
    } else {
      updateAgent({ ...agent, enabled: checked });
    }
  };

  // Fill the recommended URL only over a blank or another preset URL; never clobber custom URL, model, or key.
  // Newly choosing OpenAI or Azure recommends Responses; saved profiles keep their API until the user changes it.
  // Cache breakpoints are a per-provider, per-model opt-in, so a kind change turns them off.
  const changeKind = (kind: AgentProviderKind) => {
    const next = PROVIDER_KINDS[kind];
    const baseUrl = provider.baseUrl.trim() === '' || PRESET_URLS.has(provider.baseUrl)
      ? next.baseUrl
      : provider.baseUrl;
    commitProvider({
      kind,
      baseUrl,
      apiMode: kind === 'chatgpt'
        ? 'responses'
        : kind !== 'openai' && kind !== 'azure-openai'
          ? 'chat-completions'
          : kind === provider.kind ? provider.apiMode : 'responses',
      auth: next.auth ?? (baseUrl === '' || isLoopbackProviderUrl(baseUrl) ? 'none' : 'bearer'),
      cacheBreakpoints: kind === provider.kind && provider.cacheBreakpoints,
    }, FIELD_ID_KIND);
  };

  const startTest = () => {
    const run: TestRun = { provider: agent.provider, invalidation };
    pendingTestRef.current = run;
    setTestRun(run);
    const settle = (patch: Partial<TestRun>) => {
      if (pendingTestRef.current === run) pendingTestRef.current = null;
      setTestRun((current) => (current === run ? { ...run, ...patch } : current));
    };
    settingsIpc.testAgentProvider(agent.provider)
      .then((result) => settle({ result }))
      .catch(() => settle({ error: 'The model test could not run.' }));
  };

  const cancelTest = () => {
    pendingTestRef.current = null;
    setTestRun(null);
    settingsIpc.cancelAgentProviderTest().catch(() => undefined);
  };

  const requestUrl = getAgentProviderRequestUrl(provider);
  const apiKeyWarning = looksLikeRawApiKey(provider.apiKeyEnvVar)
    ? `Enter the environment variable name here, not the API key value. Example: ${provider.kind === 'openai-compatible' ? 'PROVIDER_API_KEY' : preset.keyPlaceholder}.`
    : undefined;

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Agent"
        description="Speak a command, and an agent runs it once with your MCP tools."
      />
      <div className="space-y-8">
        <SettingsCard>
            <ToggleRow
              title="Enable Agent Mode"
              description="The Agent Mode shortcut does nothing while this is off."
              checked={agent.enabled}
              tone="agent"
              errorId={enabledErrorId}
              error={fieldErrors[FIELD_ID_ENABLED]}
              onChange={toggleEnabled}
            />
        </SettingsCard>

        <SettingsPanel>
          <SettingsPanelHeader
            title="Model"
            description="Text fields save when you leave them."
          />
          <SettingsCard>
            <SelectRow
              label="Provider"
              value={provider.kind}
              options={Object.entries(PROVIDER_KINDS).map(([value, kind]) => ({ value, label: kind.label }))}
              errorId={kindErrorId}
              error={fieldErrors[FIELD_ID_KIND] ?? issueFor('kind')}
              onChange={(kind) => changeKind(kind as AgentProviderKind)}
            />
            {isChatGpt ? (
              chatGpt.models ? (
                <SelectRow
                  label="Model"
                  description="Models your ChatGPT plan can use."
                  value={provider.model}
                  options={chatGptModelOptions(chatGpt.models, provider.model)}
                  errorId={modelErrorId}
                  error={fieldErrors[FIELD_ID_CHATGPT_MODEL] ?? issueFor('model')}
                  onChange={(model) => commitProvider({ model }, FIELD_ID_CHATGPT_MODEL)}
                />
              ) : (
                <ReadOnlyRow
                  label="Model"
                  value={chatGpt.modelsError
                    ?? (chatGpt.canListModels ? 'Loading models…' : 'Sign in to choose a model')}
                />
              )
            ) : (
              <>
                <DraftTextRow
                  label="Base URL"
                  value={provider.baseUrl}
                  placeholder={preset.placeholder}
                  description={preset.description}
                  errorId={baseUrlErrorId}
                  error={fieldErrors[FIELD_ID_BASE_URL] ?? issueFor('baseUrl')}
                  onCommit={(baseUrl) => commitProvider({ baseUrl }, FIELD_ID_BASE_URL)}
                  clearError={() => clearFieldError(FIELD_ID_BASE_URL)}
                />
                <DraftTextRow
                  label={provider.kind === 'azure-openai' ? 'Deployment name' : 'Model'}
                  value={provider.model}
                  placeholder={provider.kind === 'azure-openai' ? 'my-gpt-deployment' : 'openai/gpt-4.1-mini'}
                  errorId={modelErrorId}
                  error={fieldErrors[FIELD_ID_MODEL] ?? issueFor('model')}
                  onCommit={(model) => commitProvider({ model }, FIELD_ID_MODEL)}
                  clearError={() => clearFieldError(FIELD_ID_MODEL)}
                />
              </>
            )}
            {provider.kind === 'openai' || provider.kind === 'azure-openai' ? (
              <SelectRow
                label="API"
                value={provider.apiMode}
                options={[
                  { value: 'chat-completions', label: 'Chat Completions' },
                  { value: 'responses', label: 'Responses' },
                ]}
                errorId={apiModeErrorId}
                error={fieldErrors[FIELD_ID_API_MODE]}
                onChange={(apiMode) =>
                  commitProvider({ apiMode: apiMode as ResolvedAgentProvider['apiMode'] }, FIELD_ID_API_MODE)}
              />
            ) : null}
            <SelectRow
              label="Reasoning"
              description="Supported levels vary by provider and model. An unsupported level can make requests fail."
              value={provider.reasoning}
              options={REASONING_OPTIONS}
              errorId={reasoningErrorId}
              error={fieldErrors[FIELD_ID_REASONING] ?? issueFor('reasoning')}
              onChange={(reasoning) =>
                commitProvider({ reasoning: reasoning as ResolvedAgentProvider['reasoning'] }, FIELD_ID_REASONING)}
            />
            {isChatGpt ? null : (
              <ReadOnlyRow label="Requests go to" value={requestUrl ?? 'Enter a valid base URL'} />
            )}
          </SettingsCard>
          {isChatGpt ? null : <Disclosure
            label="Advanced"
            defaultOpen={provider.allowInsecureHttp || provider.cacheBreakpoints}
            className="mt-3 px-1"
          >
            <SettingsCard className="mt-2">
              <ToggleRow
                title="Allow plain HTTP"
                description="Only for deliberate LAN endpoints. Prompts and keys travel unencrypted."
                checked={provider.allowInsecureHttp}
                errorId={insecureHttpErrorId}
                error={fieldErrors[FIELD_ID_INSECURE_HTTP]}
                onChange={(allowInsecureHttp) => commitProvider({ allowInsecureHttp }, FIELD_ID_INSECURE_HTTP)}
              />
              {provider.kind === 'openai' || provider.kind === 'azure-openai' ? (
                <ToggleRow
                  title="Use cache breakpoints"
                  description="Automatic prompt caching applies either way. Only turn this on if your model supports cache breakpoints (GPT-5.6 or newer); on Azure, Standard pay-as-you-go deployments only. Older models and PTU deployments reject them, so run Test model after turning it on. Cache writes may cost extra."
                  checked={provider.cacheBreakpoints}
                  errorId={cacheBreakpointsErrorId}
                  error={fieldErrors[FIELD_ID_CACHE_BREAKPOINTS]}
                  onChange={(cacheBreakpoints) => commitProvider({ cacheBreakpoints }, FIELD_ID_CACHE_BREAKPOINTS)}
                />
              ) : null}
            </SettingsCard>
          </Disclosure>}
        </SettingsPanel>

        {isChatGpt ? <ChatGptAccountPanel account={chatGpt} /> : <SettingsPanel>
          <SettingsPanelHeader title="Authentication" />
          <SettingsCard>
            <SelectRow
              label="Authentication"
              value={provider.auth}
              options={[
                { value: 'none', label: 'None' },
                { value: 'bearer', label: 'Bearer token' },
                { value: 'api-key', label: 'api-key header' },
              ]}
              errorId={authErrorId}
              error={fieldErrors[FIELD_ID_AUTH] ?? issueFor('auth')}
              onChange={(auth) => commitProvider({ auth: auth as ResolvedAgentProvider['auth'] }, FIELD_ID_AUTH)}
            />
            {provider.auth !== 'none' ? (
              <SelectRow
                label="Source"
                value={provider.apiKeySource}
                options={[
                  { value: 'environment', label: 'Environment variable' },
                  { value: 'stored', label: 'Securely saved key' },
                ]}
                errorId={apiKeySourceErrorId}
                error={fieldErrors[FIELD_ID_APIKEY_SOURCE]}
                onChange={(apiKeySource) =>
                  commitProvider({ apiKeySource: apiKeySource as ResolvedAgentProvider['apiKeySource'] }, FIELD_ID_APIKEY_SOURCE)}
              />
            ) : null}
            {provider.auth === 'none' ? null : provider.apiKeySource === 'environment' ? (
              <DraftTextRow
                label="Environment variable"
                value={provider.apiKeyEnvVar}
                placeholder={preset.keyPlaceholder}
                warning={apiKeyWarning}
                errorId={apiKeyEnvVarErrorId}
                error={fieldErrors[FIELD_ID_APIKEY] ?? issueFor('apiKeyEnvVar')}
                onCommit={(apiKeyEnvVar) => commitProvider({ apiKeyEnvVar }, FIELD_ID_APIKEY)}
                clearError={() => clearFieldError(FIELD_ID_APIKEY)}
              />
            ) : (
              <CredentialControl
                credential="agent-api-key"
                label="Saved API key"
                settingsIpc={settingsIpc}
              />
            )}
          </SettingsCard>
        </SettingsPanel>}

        <SettingsPanel>
          <SettingsPanelHeader
            title="Check"
            description={`Testing sends a short synthetic prompt and a built-in test tool, which ${isChatGpt ? 'counts toward your ChatGPT plan usage' : 'your provider may bill'}. Your MCP tools never run, and no voice or personal data is sent.`}
          />
          <SettingsCard>
            <div className="space-y-3 py-3.5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <Tag tone={issues.length > 0 ? 'warning' : 'neutral'}>
                  {!currentValidation
                    ? 'Checking settings…'
                    : issues.length > 0
                      ? `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'} to fix`
                      : currentValidation.value
                        ? 'Settings look complete'
                        : 'Could not check settings'}
                </Tag>
                {credentials === 'missing' ? (
                  <Tag tone="warning">
                    {isChatGpt
                      ? 'Not signed in to ChatGPT'
                      : provider.apiKeySource === 'stored'
                        ? 'No saved API key'
                        : `${provider.apiKeyEnvVar || 'The environment variable'} is not set`}
                  </Tag>
                ) : credentials === 'available' ? (
                  <Tag>{isChatGpt ? 'ChatGPT plan connected' : 'API key found'}</Tag>
                ) : credentials === 'not-required' ? (
                  <Tag>No API key needed</Tag>
                ) : null}
              </div>
              {issues.length > 0 ? (
                <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
                  {issues.map((issue) => <li key={`${issue.field}:${issue.message}`}>{issue.message}</li>)}
                </ul>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                {testing ? (
                  <Button type="button" size="sm" variant="outline" onClick={cancelTest}>Cancel</Button>
                ) : (
                  <Button type="button" size="sm" disabled={testBlockedReason !== null} onClick={startTest}>
                    Test model
                  </Button>
                )}
                {testBlockedReason && !testing ? (
                  <span className="text-xs text-muted-foreground">{testBlockedReason}</span>
                ) : null}
              </div>
              <div role="status" aria-live="polite" className="space-y-3">
                {testing ? <p className="text-xs text-muted-foreground">Testing the model…</p> : null}
                {currentTest?.error ? <p className="text-xs text-destructive">{currentTest.error}</p> : null}
                {currentTest?.result ? <TestResult result={currentTest.result} /> : null}
              </div>
            </div>
          </SettingsCard>
        </SettingsPanel>
      </div>

      <ConfirmDialog
        open={pendingDisable}
        title="Disable Agent Mode?"
        description="Any active agent run will be cancelled and MCP server connections will be closed."
        confirmLabel="Disable"
        onConfirm={() => {
          updateAgent({ ...agent, enabled: false });
          setPendingDisable(false);
        }}
        onCancel={() => setPendingDisable(false)}
      />
    </div>
  );
}

/** Electron prefixes rejected invoke errors with the channel name; show only the main process's message. */
function ipcErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || fallback;
}

/** Keeps a saved model selectable even when the account no longer lists it. */
function chatGptModelOptions(models: ChatGptModel[], current: string) {
  const options = models.map((model) => ({ value: model.slug, label: model.displayName }));
  return current && !models.some((model) => model.slug === current)
    ? [{ value: current, label: current }, ...options]
    : options;
}

/** Account state for the ChatGPT plan provider. Idle unless that provider is selected. */
function useChatGptAccount(settingsIpc: SettingsIpc, active: boolean) {
  const [status, setStatus] = useState<ChatGptAccountStatus | null>(null);
  const [loaded, setLoaded] = useState<{ account: string; models?: ChatGptModel[]; error?: string }>();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!active) return;
    let live = true;
    settingsIpc.getChatGptStatus()
      .then((next) => { if (live) setStatus(next); })
      .catch(() => { if (live) setStatus({ state: 'signed-out' }); });
    const unsubscribe = settingsIpc.onChatGptChanged((next) => setStatus(next));
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [active, settingsIpc]);

  // Re-list per account: entitlements differ between accounts and workspaces.
  const modelAccount = active && status?.state === 'signed-in' && status.planUsage ? status.email : null;
  useEffect(() => {
    if (modelAccount === null) return;
    let live = true;
    settingsIpc.listChatGptModels()
      .then((next) => { if (live) setLoaded({ account: modelAccount, models: next }); })
      .catch((err: unknown) => {
        if (live) setLoaded({ account: modelAccount, error: ipcErrorMessage(err, 'Could not load models for this account.') });
      });
    return () => { live = false; };
  }, [modelAccount, settingsIpc]);
  const current = loaded?.account === modelAccount ? loaded : undefined;
  const models = current?.models ?? null;
  const modelsError = current?.error;

  const signIn = () => {
    setSigningIn(true);
    setError(undefined);
    settingsIpc.signInChatGpt()
      .then(setStatus)
      .catch((err: unknown) => setError(ipcErrorMessage(err, 'Sign-in did not finish. Try again.')))
      .finally(() => setSigningIn(false));
  };

  const signOut = () => {
    setError(undefined);
    settingsIpc.signOutChatGpt()
      .then(setStatus)
      .catch((err: unknown) => setError(ipcErrorMessage(err, 'Could not disconnect. Try again.')));
  };

  return { status, models, modelsError, canListModels: modelAccount !== null, signingIn, error, signIn, signOut };
}

// OpenAI mark from svgl.app, viewBox cropped to the glyph so it sizes like an icon.
function OpenAiLogo() {
  return (
    <svg viewBox="100 100 411 411" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M252.794 108.802C289.191 99.0484 326.265 110.305 351.148 135.135C385.113 126.072 422.85 134.862 449.492 161.505C476.136 188.149 484.925 225.888 475.862 259.85V259.854C500.696 284.735 511.95 321.81 502.198 358.207C492.447 394.602 464.161 421.084 430.215 430.217C421.083 464.162 394.603 492.448 358.206 502.199C321.812 511.951 284.734 500.693 259.852 475.864C225.887 484.927 188.15 476.137 161.507 449.495C134.864 422.851 126.073 385.111 135.136 351.149C110.304 326.266 99.0496 289.192 108.801 252.795C118.552 216.4 146.84 189.918 180.784 180.785C189.917 146.841 216.396 118.553 252.794 108.802ZM374.292 407.145C374.292 411.271 372.092 415.086 368.517 417.148L283.723 466.102C302.487 480.585 327.555 486.459 352.217 479.852C386.997 470.532 410.068 439.312 410.555 405.006V317.717C410.555 315.08 409.125 312.621 406.843 311.303L374.292 292.509V407.145ZM251.868 415.897C248.296 417.959 243.893 417.959 240.317 415.897L155.526 366.942C152.366 390.436 159.811 415.08 177.866 433.136H177.863C203.325 458.594 241.896 462.962 271.85 446.232L347.449 402.586C349.735 401.268 351.148 398.8 351.148 396.163V358.579L251.868 415.897ZM368.602 220.628C366.319 219.309 363.474 219.318 361.191 220.637L328.641 239.431L427.921 296.749C431.496 298.811 433.697 302.627 433.697 306.752V404.661C455.622 395.654 473.244 376.881 479.851 352.218C489.169 317.442 473.668 281.85 444.201 264.274L368.602 220.628ZM177.303 206.34C155.377 215.348 137.756 234.122 131.148 258.783C121.832 293.561 137.331 329.153 166.799 346.727L242.398 390.373C244.68 391.692 247.525 391.684 249.807 390.366L282.357 371.572L183.078 314.253C179.504 312.189 177.303 308.375 177.303 304.251V206.34ZM259.849 279.145V331.858L305.5 358.213L351.15 331.858V279.145L305.5 252.789L259.849 279.145ZM327.276 144.9C308.512 130.418 283.445 124.543 258.782 131.15C224.002 140.471 200.931 171.691 200.445 205.995V293.286C200.445 295.923 201.875 298.381 204.158 299.7L236.707 318.493V203.856C236.707 199.731 238.909 195.916 242.483 193.853L327.276 144.9ZM433.137 177.867C407.675 152.407 369.103 148.038 339.149 164.769L263.55 208.415C261.265 209.734 259.852 212.202 259.852 214.838V252.423L359.132 195.105C362.703 193.041 367.108 193.041 370.682 195.105L455.473 244.06C458.635 220.567 451.189 195.922 433.135 177.867H433.137Z" />
    </svg>
  );
}

function ChatGptAccountPanel({ account }: { account: ReturnType<typeof useChatGptAccount> }) {
  const { status, signingIn, error, signIn, signOut } = account;
  const continueButton = (
    <Button type="button" size="sm" disabled={signingIn} onClick={signIn}>
      <OpenAiLogo />
      Continue with ChatGPT
    </Button>
  );

  return (
    <SettingsPanel>
      <SettingsPanelHeader
        title="ChatGPT account"
        description="Agent Mode uses your ChatGPT Plus or Pro plan. No API key needed, and usage limits from your plan apply."
      />
      <SettingsCard>
        {status?.state === 'signed-in' ? <ReadOnlyRow label="Signed in as" value={status.email} /> : null}
        <div className="space-y-3 py-3.5">
          {status === null ? (
            <p className="text-xs text-muted-foreground">Checking your account…</p>
          ) : status.state === 'signed-out' ? (
            <p className="text-xs leading-5 text-muted-foreground">
              Sign in opens your browser. Shuddhalekhan never sees your ChatGPT password.
            </p>
          ) : status.planUsage ? (
            <Tag tone="success">Agent Mode uses your ChatGPT plan</Tag>
          ) : (
            <p className="text-xs leading-5 text-warning">
              You did not allow Shuddhalekhan to use your ChatGPT plan. Continue with ChatGPT and allow it to use Agent Mode.
            </p>
          )}
          {status === null ? null : (
            <div className="flex flex-wrap items-center gap-3">
              {status.state === 'signed-out' || !status.planUsage ? continueButton : null}
              {status.state === 'signed-in' && status.planUsage ? (
                <Button asChild type="button" size="sm" variant="outline">
                  <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
                </Button>
              ) : null}
              {status.state === 'signed-in' ? (
                <Button type="button" size="sm" variant="ghost" onClick={signOut}>Disconnect</Button>
              ) : null}
            </div>
          )}
          <div role="status" aria-live="polite">
            {signingIn ? <p className="text-xs text-muted-foreground">Finish signing in in your browser…</p> : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        </div>
      </SettingsCard>
    </SettingsPanel>
  );
}

function TestResult({ result }: { result: AgentProviderTestResult }) {
  const { diagnostic } = result;
  const passed = result.streaming.status === 'passed' && result.tools.status === 'passed';
  return (
    <div className="space-y-2 text-xs leading-5">
      <p className="text-muted-foreground">
        {passed ? 'Model test passed' : 'Model test did not pass'} · {new Date(result.checkedAt).toLocaleString()}
      </p>
      <CheckLine label="Streaming" check={result.streaming} />
      <CheckLine label="Tool call" check={result.tools} />
      {result.warnings.map((warning) => <p key={warning} className="text-warning">{warning}</p>)}
      {diagnostic ? (
        <div className="space-y-1 rounded-md bg-destructive/10 px-2.5 py-2">
          <p className="text-destructive">{diagnostic.message}</p>
          <p>{diagnostic.action}</p>
          {diagnostic.statusCode !== undefined || diagnostic.requestId ? (
            <p className="text-muted-foreground">
              {[
                diagnostic.statusCode !== undefined ? `HTTP ${diagnostic.statusCode}` : null,
                diagnostic.requestId ? `Request ID ${diagnostic.requestId}` : null,
              ].filter(Boolean).join(' · ')}
            </p>
          ) : null}
          {diagnostic.details ? (
            <Disclosure label="Technical details">
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
                {diagnostic.details.slice(0, DIAGNOSTIC_DETAIL_LIMIT)}
              </pre>
            </Disclosure>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CheckLine({ label, check }: { label: string; check: AgentProviderCheck }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <span className="font-medium">{label}</span>
      <Tag tone={CHECK_TONE[check.status]}>{CHECK_LABEL[check.status]}</Tag>
      <span className="text-muted-foreground">{check.message}</span>
    </div>
  );
}
