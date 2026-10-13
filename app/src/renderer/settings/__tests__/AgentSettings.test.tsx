import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentSettings } from '../AgentSettings';
import type { SettingsIpc } from '../settings-ipc';
import type { SettingsSectionProps } from '../settings-section-props';
import type {
  AgentProviderConfig,
  AgentProviderTestResult,
  AgentProviderValidation,
  AppConfig,
} from '../../../types/ipc';

afterEach(cleanup);

const OK: AgentProviderValidation = { issues: [], credentials: 'available' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function passedResult(checkedAt = '2026-10-13T10:00:00.000Z'): AgentProviderTestResult {
  return {
    checkedAt,
    validation: OK,
    streaming: { status: 'passed', message: 'Streamed a reply.' },
    tools: { status: 'passed', message: 'Completed a tool round trip.' },
    warnings: [],
  };
}

/** Renders AgentSettings against a tiny in-memory config so commits re-render like the real window. */
async function renderAgent({
  provider = {},
  enabled = true,
  validate = () => Promise.resolve(OK),
  test = () => Promise.resolve(passedResult()),
}: {
  provider?: Partial<AgentProviderConfig>;
  enabled?: boolean;
  validate?: (provider: AgentProviderConfig) => Promise<AgentProviderValidation>;
  test?: (provider: AgentProviderConfig) => Promise<AgentProviderTestResult>;
} = {}) {
  let agent: AppConfig['agent'] = {
    enabled,
    provider: {
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4.1-mini',
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      ...provider,
    },
    mcpServers: [],
  };
  let invalidate: () => void = () => undefined;
  const settingsIpc = {
    validateAgentProvider: mock(validate),
    testAgentProvider: mock(test),
    cancelAgentProviderTest: mock(() => Promise.resolve()),
    onAgentProviderInvalidated: mock((callback: () => void) => {
      invalidate = callback;
      return () => undefined;
    }),
    getCredentialStatus: mock(() => Promise.resolve({ available: true as const, exists: false })),
  };
  const commit = mock(async (_key: 'agent', value: AppConfig['agent']) => {
    agent = value;
    view.rerender(<AgentSettings {...props()} />);
  });
  const props = () => ({
    config: { agent } as AppConfig,
    persistence: { commit, fieldErrors: {}, clearFieldError: () => undefined, toast: null },
    settingsIpc: settingsIpc as unknown as SettingsIpc,
  }) as unknown as SettingsSectionProps;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<AgentSettings {...props()} />);
  });
  return {
    settingsIpc,
    commit,
    unmount: () => view.unmount(),
    lastProvider: () => agent.provider,
    invalidate: () => act(async () => invalidate()),
    updateProvider: (patch: Partial<AgentProviderConfig>) => act(async () => {
      agent = { ...agent, provider: { ...agent.provider, ...patch } };
      view.rerender(<AgentSettings {...props()} />);
    }),
  };
}

/** Clicks inside an async act so the re-validation a commit triggers settles before assertions. */
const click = (element: HTMLElement) => act(async () => { fireEvent.click(element); });

async function chooseOption(combobox: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: combobox }));
  await click(await screen.findByRole('option', { name: option }));
}

async function startTest() {
  const button = await screen.findByRole('button', { name: 'Test model' });
  await waitFor(() => expect(button).toBeEnabled());
  await click(button);
}

describe('AgentSettings provider kind', () => {
  it('fills the recommended URL, Responses API, and standard auth over a preset, keeping model and key', async () => {
    const { lastProvider } = await renderAgent();

    await chooseOption('Provider', 'OpenAI');

    expect(lastProvider()).toMatchObject({
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiMode: 'responses',
      auth: 'bearer',
      model: 'openai/gpt-4.1-mini',
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
    });
    expect(screen.getByRole('combobox', { name: 'API' })).toBeInTheDocument();
  });

  it('keeps a saved Chat Completions profile as it is', async () => {
    const { commit } = await renderAgent({ provider: { kind: 'openai', apiMode: 'chat-completions' } });

    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'API' })).toHaveTextContent('Chat Completions');
  });

  it('never clobbers a custom URL and labels Azure models as deployments', async () => {
    const { lastProvider } = await renderAgent({
      provider: { kind: 'openai-compatible', baseUrl: 'https://my-res.openai.azure.com/openai/v1' },
    });

    await chooseOption('Provider', 'Azure OpenAI (v1)');

    expect(lastProvider()).toMatchObject({
      kind: 'azure-openai',
      baseUrl: 'https://my-res.openai.azure.com/openai/v1',
      auth: 'api-key',
      apiMode: 'responses',
    });
    expect(screen.getByRole('textbox', { name: 'Deployment name' })).toBeInTheDocument();
    expect(screen.getByText('https://my-res.openai.azure.com/openai/v1/responses')).toBeInTheDocument();
  });

  it('forces Chat Completions and recommends no auth for a fresh local endpoint', async () => {
    const { lastProvider } = await renderAgent({ provider: { kind: 'openai', apiMode: 'responses' } });

    await chooseOption('Provider', 'Local or custom (OpenAI-compatible)');

    expect(lastProvider()).toMatchObject({ kind: 'openai-compatible', baseUrl: '', apiMode: 'chat-completions', auth: 'none' });
    expect(screen.queryByRole('combobox', { name: 'API' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Source' })).not.toBeInTheDocument();
  });

  it('lets an OpenAI profile on a LAN gateway explicitly allow plain HTTP and keep Responses', async () => {
    const { lastProvider } = await renderAgent({
      provider: { kind: 'openai', apiMode: 'responses', baseUrl: 'http://192.168.1.20:4000/v1' },
    });

    await click(screen.getByRole('button', { name: 'Advanced' }));
    const toggle = screen.getByRole('switch', { name: 'Allow plain HTTP' });
    expect(toggle).not.toBeChecked();
    await click(toggle);

    expect(lastProvider()).toMatchObject({ kind: 'openai', apiMode: 'responses', allowInsecureHttp: true });
  });

  it('saves the cache breakpoint opt-in for native OpenAI and turns it off when the provider kind changes', async () => {
    const { lastProvider } = await renderAgent({ provider: { kind: 'openai', baseUrl: 'https://api.openai.com/v1' } });

    await click(screen.getByRole('button', { name: 'Advanced' }));
    const toggle = screen.getByRole('switch', { name: 'Use cache breakpoints' });
    expect(toggle).not.toBeChecked();
    await click(toggle);
    expect(lastProvider()).toMatchObject({ kind: 'openai', cacheBreakpoints: true });

    await chooseOption('Provider', 'OpenRouter');
    expect(lastProvider()).toMatchObject({ kind: 'openrouter', cacheBreakpoints: false });
    expect(screen.queryByRole('switch', { name: 'Use cache breakpoints' })).not.toBeInTheDocument();
  });

  it('gives a raw-key warning example for the current provider', async () => {
    const { updateProvider } = await renderAgent({ provider: { kind: 'azure-openai', apiKeyEnvVar: 'sk-abcdefghijklmnopqrstuvwxyz123456' } });
    expect(screen.getByText(/Example: AZURE_OPENAI_API_KEY\./)).toBeInTheDocument();

    await updateProvider({ kind: 'openai-compatible', auth: 'bearer' });
    expect(screen.getByText(/Example: PROVIDER_API_KEY\./)).toBeInTheDocument();
  });
});

describe('AgentSettings provider checks', () => {
  it('shows local issues inline and blocks the network test', async () => {
    await renderAgent({
      validate: () => Promise.resolve({
        issues: [{ field: 'model', message: 'Enter the model identifier.' }],
        credentials: 'available',
      }),
    });

    expect(await screen.findAllByText('Enter the model identifier.')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Test model' })).toBeDisabled();
    expect(screen.getByText('Fix the settings issues before testing.')).toBeInTheDocument();
  });

  it('reports a missing credential without testing and explains Agent Mode being off', async () => {
    await renderAgent({ enabled: false, validate: () => Promise.resolve({ issues: [], credentials: 'missing' }) });

    expect(await screen.findByText('OPENROUTER_API_KEY is not set')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test model' })).toBeDisabled();
    expect(screen.getByText(/Turn on Agent Mode to test the model/)).toBeInTheDocument();
  });

  it('ignores a late validation result for a provider that has since changed', async () => {
    const first = deferred<AgentProviderValidation>();
    const second = deferred<AgentProviderValidation>();
    const pending = [first, second];
    const { updateProvider } = await renderAgent({ validate: () => pending.shift()!.promise });

    await updateProvider({ model: 'openai/gpt-5' });
    await act(async () => second.resolve(OK));
    await act(async () => first.resolve({ issues: [{ field: 'model', message: 'Stale issue' }], credentials: 'available' }));

    expect(screen.queryByText('Stale issue')).not.toBeInTheDocument();
    expect(screen.getByText('Settings look complete')).toBeInTheDocument();
  });

  it('runs an explicit test and shows separate streaming and tool results', async () => {
    const { settingsIpc } = await renderAgent();

    await startTest();

    expect(await screen.findByText('Streamed a reply.')).toBeInTheDocument();
    expect(screen.getByText('Completed a tool round trip.')).toBeInTheDocument();
    expect(screen.getByText(/Model test passed/)).toBeInTheDocument();
    expect(settingsIpc.testAgentProvider).toHaveBeenCalledTimes(1);
  });

  it('shows an actionable diagnostic with bounded technical details', async () => {
    await renderAgent({
      test: () => Promise.resolve({
        ...passedResult(),
        streaming: { status: 'failed', message: 'The provider rejected the request.' },
        tools: { status: 'not-checked', message: 'Tool calling was not checked.' },
        diagnostic: {
          kind: 'authentication',
          message: 'The API key was rejected.',
          action: 'Check the key for this provider.',
          statusCode: 401,
          requestId: 'req_123',
          details: 'x'.repeat(10_000),
        },
      }),
    });

    await startTest();

    expect(await screen.findByText('The API key was rejected.')).toBeInTheDocument();
    expect(screen.getByText('HTTP 401 · Request ID req_123')).toBeInTheDocument();
    expect(screen.getByText(/Model test did not pass/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Technical details' }));
    expect(screen.getByText(/^x+$/).textContent).toHaveLength(4000);
  });

  it('cancels an in-flight test and ignores its late result', async () => {
    const run = deferred<AgentProviderTestResult>();
    const { settingsIpc } = await renderAgent({ test: () => run.promise });

    await startTest();
    await click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => run.resolve(passedResult()));

    expect(settingsIpc.cancelAgentProviderTest).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Streamed a reply.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test model' })).toBeInTheDocument();
  });

  it('cancels a pending test and clears results when credentials are invalidated', async () => {
    const run = deferred<AgentProviderTestResult>();
    const { settingsIpc, invalidate } = await renderAgent({ test: () => run.promise });

    await startTest();
    await invalidate();
    await act(async () => run.resolve(passedResult()));

    expect(settingsIpc.cancelAgentProviderTest).toHaveBeenCalledTimes(1);
    expect(settingsIpc.validateAgentProvider).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Streamed a reply.')).not.toBeInTheDocument();
  });

  it('cancels and clears a pending test when Agent Mode is disabled', async () => {
    const run = deferred<AgentProviderTestResult>();
    const { settingsIpc } = await renderAgent({ test: () => run.promise });

    await startTest();
    await click(screen.getByRole('switch', { name: 'Enable Agent Mode' }));
    await click(await screen.findByRole('button', { name: 'Disable' }));
    await act(async () => run.resolve(passedResult()));

    expect(settingsIpc.cancelAgentProviderTest).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Testing the model…')).not.toBeInTheDocument();
    expect(screen.queryByText('Streamed a reply.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test model' })).toBeDisabled();
  });

  it('cancels a pending test when the page unmounts', async () => {
    const { settingsIpc, unmount } = await renderAgent({ test: () => new Promise(() => undefined) });

    await startTest();
    unmount();

    expect(settingsIpc.cancelAgentProviderTest).toHaveBeenCalledTimes(1);
  });
});
