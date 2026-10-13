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
import type {
  AgentProviderCheck,
  AgentProviderConfig,
  AgentProviderIssue,
  AgentProviderKind,
  AgentProviderTestResult,
  AgentProviderValidation,
  AppConfig,
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
const DIAGNOSTIC_DETAIL_LIMIT = 4000;

/** Recommended defaults applied when the user picks a provider kind. */
const PROVIDER_KINDS: Record<AgentProviderKind, {
  label: string;
  baseUrl: string;
  placeholder: string;
  keyPlaceholder: string;
  auth?: ResolvedAgentProvider['auth'];
  description?: string;
}> = {
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
            ? 'Add an API key before testing.'
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
      apiMode: kind !== 'openai' && kind !== 'azure-openai'
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
            <ReadOnlyRow label="Requests go to" value={requestUrl ?? 'Enter a valid base URL'} />
          </SettingsCard>
          <Disclosure
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
          </Disclosure>
        </SettingsPanel>

        <SettingsPanel>
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
        </SettingsPanel>

        <SettingsPanel>
          <SettingsPanelHeader
            title="Check"
            description="Testing sends a short synthetic prompt and a built-in test tool, which your provider may bill. Your MCP tools never run, and no voice or personal data is sent."
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
                    {provider.apiKeySource === 'stored'
                      ? 'No saved API key'
                      : `${provider.apiKeyEnvVar || 'The environment variable'} is not set`}
                  </Tag>
                ) : credentials === 'available' ? (
                  <Tag>API key found</Tag>
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
