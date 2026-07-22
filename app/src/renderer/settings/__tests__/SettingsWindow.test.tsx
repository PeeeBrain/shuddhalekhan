import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { SettingsIpc } from '../settings-ipc';
import type {
  AppConfig,
  AppInfo,
  AuditEventDetail,
  AuditRunSummary,
  McpServerRuntimeStatus,
  UpdateStatus,
  CredentialStatus,
} from '../../../types/ipc';
import { SettingsWindow } from '../../SettingsWindow';

afterEach(cleanup);

const AUDIO_DEVICES_PLACEHOLDER = null;

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    whisperUrl: 'http://localhost:8080/inference',
    transcription: {
      activeProvider: 'local-whisper-cpp',
      providers: {
      localWhisperCpp: { endpoint: 'http://localhost:8080/inference' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
      azureSpeech: { endpoint: '', region: '' },
      googleCloudSpeech: { project: '', location: 'global', model: '', credentialSource: 'service-account' },
      nvidiaSpeechNim: { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
      customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
    },
    },
    selectedDeviceId: AUDIO_DEVICES_PLACEHOLDER,
    removeFillerWords: true,
    language: 'auto',
    task: 'transcribe',
    dictionary: [],
    pasteStrategy: { default: 'ctrl-v', overrides: {} },
    setupChecklistDismissed: true,
    recordingActivationMode: 'push-to-talk',
    shortcuts: {
      dictation: { binding: { keyCode: null, modifiers: ['ctrl', 'win'] }, activationMode: 'push-to-talk' },
      agent: { binding: { keyCode: null, modifiers: ['alt', 'win'] }, activationMode: 'push-to-talk' },
    },
    agent: {
      enabled: false,
      provider: {
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openai/gpt-4.1-mini',
        apiKeyEnvVar: 'OPENROUTER_API_KEY',
        thinkingEnabled: false,
      },
      mcpServers: [],
    },
    ...overrides,
  };
}

const APP_INFO: AppInfo = {
  name: 'Shuddhalekhan',
  version: '0.0.0-development',
  isPackaged: false,
};

const UPDATE_STATUS: UpdateStatus = {
  state: 'latest',
  currentVersion: '0.0.0-development',
  latestVersion: '0.0.0-development',
  message: 'Up to date',
  checkedAt: '2026-07-20T00:00:00.000Z',
};

interface MockSettingsIpcOptions {
  config?: AppConfig;
  failSetConfig?: boolean;
  auditRuns?: AuditRunSummary[];
  auditRunDetail?: AuditEventDetail[];
  credentialStatus?: CredentialStatus;
}

function createMockSettingsIpc(
  options: MockSettingsIpcOptions = {},
): SettingsIpc {
  let config: AppConfig = options.config ?? baseConfig();

  const setConfigMock = mock(
    async (key: keyof AppConfig, value: AppConfig[keyof AppConfig]) => {
      config = { ...config, [key]: value };
      if (options.failSetConfig) throw new Error('storage unavailable');
    },
  );

  return {
    getConfig: mock(() => Promise.resolve(config)),
    setConfig: setConfigMock as SettingsIpc['setConfig'],
    getAppInfo: mock(() => Promise.resolve(APP_INFO)),
    getUpdateStatus: mock(() => Promise.resolve(UPDATE_STATUS)),
    checkForUpdates: mock(() => Promise.resolve(UPDATE_STATUS)),
    testMcpServer: mock(() => Promise.resolve()),
    checkTranscriptionServer: mock(() => Promise.resolve(true)),
    getShortcutsPaused: mock(() => Promise.resolve(false)),
    setShortcutsPaused: mock((paused: boolean) => Promise.resolve(paused)),
    beginShortcutCapture: mock(() => Promise.resolve()),
    endShortcutCapture: mock(() => Promise.resolve()),
    onShortcutsPausedChanged: mock(() => undefined),
    onUpdateStatusChanged: mock(() => undefined),
    onMcpServerStatus: mock(
      (_callback: (status: McpServerRuntimeStatus) => void) => undefined,
    ),
    getAuditRuns: mock(() => Promise.resolve(options.auditRuns ?? [])),
    getAuditRunDetail: mock(() => Promise.resolve(options.auditRunDetail ?? [])),
    onAuditRunUpdated: mock((_callback: (runId: string) => void) => undefined),
    getCredentialStatus: mock(() => Promise.resolve(options.credentialStatus ?? { available: true, exists: false })),
    saveCredential: mock(() => Promise.resolve({ available: true, exists: true })),
    removeCredential: mock(() => Promise.resolve({ available: true, exists: false })),
  };
}

function renderSettings(options?: MockSettingsIpcOptions) {
  const settingsIpc = createMockSettingsIpc(options);
  const result = render(<SettingsWindow settingsIpc={settingsIpc} />);
  return { settingsIpc, ...result };
}

async function waitForLoaded() {
  await waitFor(() => {
    expect(screen.getByRole('tab', { name: 'Transcription' })).toBeInTheDocument();
  });
}

function getTabs() {
  return screen.getAllByRole('tab');
}

function tabByLabel(label: string) {
  return screen.getByRole('tab', { name: label });
}

describe('Settings navigation', () => {
  it('groups destinations into Dictation, Agent, and System with no General', async () => {
    renderSettings();
    await waitForLoaded();

    const groupLabels = ['Dictation', 'Agent', 'System'];
    for (const label of groupLabels) {
      expect(
        screen.getAllByText(label).some((el) => el.id === `settings-group-${label.toLowerCase()}`),
      ).toBe(true);
      expect(screen.getByRole('tablist', { name: label })).toHaveAttribute(
        'aria-orientation',
        'vertical',
      );
    }

    expect(screen.queryByRole('tab', { name: 'General' })).toBeNull();
  });

  it('lists the seven destinations in order', async () => {
    renderSettings();
    await waitForLoaded();

    const expected = [
      'Transcription',
      'Audio',
      'Shortcuts',
      'Agent',
      'MCP Servers',
      'History',
      'About',
    ];
    expect(getTabs().map((tab) => tab.textContent ?? '')).toEqual(expected);
  });

  it('opens on Transcription as the initial destination', async () => {
    renderSettings();
    await waitForLoaded();

    expect(tabByLabel('Transcription')).toHaveAttribute('aria-selected', 'true');
  });

  it('switches sections and exposes the active tab panel when a tab is clicked', async () => {
    renderSettings();
    await waitForLoaded();

    fireEvent.click(tabByLabel('About'));

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'panel-about');
    expect(panel).toHaveAttribute('aria-labelledby', 'tab-about');
    expect(tabByLabel('About')).toHaveAttribute('aria-selected', 'true');
    expect(tabByLabel('Transcription')).toHaveAttribute('aria-selected', 'false');
  });

  it('moves selection and focus with arrow keys across navigation', async () => {
    renderSettings();
    await waitForLoaded();

    const transcriptionTab = tabByLabel('Transcription');
    fireEvent.focus(transcriptionTab);
    fireEvent.keyDown(transcriptionTab, { key: 'ArrowDown' });

    expect(tabByLabel('Audio')).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(tabByLabel('Audio'), { key: 'ArrowUp' });
    expect(tabByLabel('Transcription')).toHaveAttribute('aria-selected', 'true');
  });

  it('jumps to the first section with Home and the last with End', async () => {
    renderSettings();
    await waitForLoaded();

    const audioTab = tabByLabel('Audio');
    fireEvent.focus(audioTab);
    fireEvent.keyDown(audioTab, { key: 'End' });
    expect(tabByLabel('About')).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(tabByLabel('About'), { key: 'Home' });
    expect(tabByLabel('Transcription')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Settings section reachability', () => {
  it('shows provider-neutral local transcription controls', async () => {
    const { settingsIpc } = renderSettings();
    await waitForLoaded();

    expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveTextContent('Local whisper.cpp');
    expect(screen.getByRole('switch', { name: 'Clean transcription' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Endpoint' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check server' }));
    await waitFor(() => expect(settingsIpc.checkTranscriptionServer).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Reachable')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Spoken language' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Add dictionary word' })).toBeInTheDocument();
  });

  it('groups all six provider choices with descriptions and readiness', async () => {
    renderSettings();
    await waitForLoaded();

    expect(screen.getByText('Configured')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: 'Provider' }));

    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(6);
    for (const name of [
      'Local whisper.cpp',
      'OpenAI',
      'Microsoft Azure Speech',
      'Google Cloud Speech-to-Text v2',
      'NVIDIA Speech NIM',
      'Custom OpenAI-compatible',
    ]) {
      expect(options.some((option) => option.textContent?.includes(name))).toBe(true);
    }
    expect(screen.getByText('Cloud')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
    expect(screen.getByText('OpenAI batch audio transcription.')).toBeInTheDocument();
  });

  it('shows provider-native Microsoft Azure Speech setup without a model field', async () => {
    const config = baseConfig();
    const { settingsIpc } = renderSettings({
      config: {
        ...config,
        transcription: {
          activeProvider: 'azure-speech',
          providers: {
            ...config.transcription.providers,
            azureSpeech: { endpoint: '', region: 'centralindia' },
            googleCloudSpeech: { project: '', location: 'global', model: '', credentialSource: 'service-account' },
            nvidiaSpeechNim: { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
          },
        },
      },
    });
    await waitForLoaded();

    expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveTextContent('Microsoft Azure Speech');
    expect(screen.getByRole('textbox', { name: 'Resource endpoint' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Region' })).toHaveValue('centralindia');
    expect(screen.getByLabelText('Azure Speech key')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Model' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Check/ })).toBeNull();
    expect(screen.getByRole('note', { name: 'Transcription privacy note' })).toHaveTextContent('Microsoft Azure');
    expect(screen.getByText(/does not send test audio or make a billable Azure request/i)).toBeInTheDocument();

    const mode = screen.getByRole('combobox', { name: 'Mode' });
    fireEvent.click(mode);
    expect(await screen.findByRole('option', { name: /Translate speech to English/ })).toHaveAttribute('data-disabled');
    expect(settingsIpc.checkTranscriptionServer).not.toHaveBeenCalled();
  });

  it('shows Google Cloud setup, secure document import, explicit limitations, and advanced ADC', async () => {
    const current = baseConfig();
    renderSettings({ config: {
      ...current,
      language: 'en',
      transcription: {
        ...current.transcription,
        activeProvider: 'google-cloud-speech-v2',
        providers: {
          ...current.transcription.providers,
          googleCloudSpeech: { project: 'sample-project-123', location: 'global', model: 'short', credentialSource: 'service-account' },
        },
      },
    } });
    await waitForLoaded();

    expect(screen.getByRole('textbox', { name: 'Project ID' })).toHaveValue('sample-project-123');
    expect(screen.getByRole('textbox', { name: 'Location' })).toHaveValue('global');
    expect(screen.getByRole('textbox', { name: 'Model' })).toHaveValue('short');
    expect(screen.getByLabelText('Service-account JSON document')).toHaveAttribute('type', 'file');
    expect(screen.getByText(/stop automatically at 55 seconds/i)).toBeInTheDocument();
    expect(screen.getByRole('note', { name: 'Transcription privacy note' })).toHaveTextContent('Google Cloud');
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByRole('combobox', { name: 'Credential source' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: 'Mode' }));
    expect(await screen.findByRole('option', { name: /not supported by Google/ })).toHaveAttribute('data-disabled');
  });

  it('shows self-hosted NVIDIA Speech NIM fields and an unauthenticated connectivity check', async () => {
    const current = baseConfig();
    renderSettings({ config: {
      ...current,
      language: 'en',
      transcription: {
        ...current.transcription,
        activeProvider: 'nvidia-speech-nim',
        providers: {
          ...current.transcription.providers,
          nvidiaSpeechNim: { ...current.transcription.providers.nvidiaSpeechNim, endpoint: 'http://localhost:9000/v1/audio/transcriptions', model: 'nvidia/parakeet' },
        },
      },
    } });
    await waitForLoaded();

    expect(screen.getByRole('textbox', { name: 'Endpoint' })).toHaveValue('http://localhost:9000/v1/audio/transcriptions');
    expect(screen.getByRole('textbox', { name: 'Model' })).toHaveValue('nvidia/parakeet');
    expect(screen.getByRole('button', { name: 'Check connectivity' })).toBeInTheDocument();
    expect(screen.getByText(/user-hosted, not an NVIDIA managed cloud service/i)).toBeInTheDocument();
    expect(screen.getByRole('note', { name: 'Transcription privacy note' })).toHaveTextContent('configured NVIDIA Speech NIM endpoint');
  });

  it('shows shared device rows without the removed shared activation setting', async () => {
    renderSettings();
    await waitForLoaded();

    fireEvent.click(tabByLabel('Audio'));

    expect(screen.queryByRole('combobox', { name: 'Recording activation' })).not.toBeInTheDocument();
    expect(screen.getByText('Selected device')).toBeInTheDocument();
    expect(screen.getByText('Capture path')).toBeInTheDocument();
  });

  it('shows both hotkey displays on the Shortcuts section', async () => {
    renderSettings();
    await waitForLoaded();

    fireEvent.click(tabByLabel('Shortcuts'));

    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('Dictation')).toBeInTheDocument();
    expect(within(panel).getByText('Agent Mode')).toBeInTheDocument();
    expect(within(panel).getByText('Ctrl').closest('kbd')).toBeInTheDocument();
    expect(within(panel).getByText('Alt').closest('kbd')).toBeInTheDocument();
    expect(panel.querySelectorAll('kbd')).toHaveLength(4);
  });

  it('captures and saves a normalized shortcut inline on release', async () => {
    const { settingsIpc } = renderSettings();
    await waitForLoaded();
    fireEvent.click(tabByLabel('Shortcuts'));

    fireEvent.click(screen.getAllByRole('button', { name: 'Change' })[0]);
    const capture = await screen.findByRole('group', { name: 'Capture Dictation shortcut' });
    expect(settingsIpc.beginShortcutCapture).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(capture, { code: 'ControlRight', key: 'Control' });
    fireEvent.keyDown(capture, { code: 'KeyR', key: 'r' });
    fireEvent.keyUp(capture, { code: 'KeyR', key: 'r' });
    fireEvent.keyUp(capture, { code: 'ControlRight', key: 'Control' });

    await waitFor(() => {
      expect(settingsIpc.setConfig).toHaveBeenCalledWith(
        'shortcuts',
        expect.objectContaining({
          dictation: {
            binding: { keyCode: 0x52, modifiers: ['ctrl'] },
            activationMode: 'push-to-talk',
          },
        }),
      );
    });
    expect(settingsIpc.endShortcutCapture).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Settings saved')).toBeInTheDocument();
  });

  it('requires Use anyway before saving a disruptive bare-key shortcut', async () => {
    const { settingsIpc } = renderSettings();
    await waitForLoaded();
    fireEvent.click(tabByLabel('Shortcuts'));

    fireEvent.click(screen.getAllByRole('button', { name: 'Change' })[0]);
    const capture = await screen.findByRole('group', { name: 'Capture Dictation shortcut' });
    fireEvent.keyDown(capture, { code: 'KeyR', key: 'r' });
    fireEvent.keyUp(capture, { code: 'KeyR', key: 'r' });

    expect(await screen.findByText('This shortcut can disrupt normal typing')).toBeInTheDocument();
    expect(settingsIpc.setConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use anyway' }));

    await waitFor(() => expect(settingsIpc.setConfig).toHaveBeenCalledWith(
      'shortcuts',
      expect.objectContaining({
        dictation: expect.objectContaining({ binding: { keyCode: 0x52, modifiers: [] } }),
      }),
    ));
  });

  it('rejects an ambiguous binding and restores normal hook operation on Escape', async () => {
    const { settingsIpc } = renderSettings();
    await waitForLoaded();
    fireEvent.click(tabByLabel('Shortcuts'));

    const change = screen.getAllByRole('button', { name: 'Change' })[0];
    fireEvent.click(change);
    const capture = await screen.findByRole('group', { name: 'Capture Dictation shortcut' });
    fireEvent.keyDown(capture, { code: 'AltLeft', key: 'Alt' });
    fireEvent.keyDown(capture, { code: 'MetaLeft', key: 'Meta' });
    fireEvent.keyUp(capture, { code: 'AltLeft', key: 'Alt' });
    fireEvent.keyUp(capture, { code: 'MetaLeft', key: 'Meta' });

    expect(await screen.findByText(/cannot use the same shortcut/i)).toBeInTheDocument();
    expect(settingsIpc.setConfig).not.toHaveBeenCalled();
    fireEvent.keyDown(capture, { code: 'Escape', key: 'Escape' });

    await waitFor(() => expect(settingsIpc.endShortcutCapture).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/capture cancelled/i)).toBeInTheDocument();
  });

  it('clears a binding with idle Backspace and toggles session-only pause', async () => {
    const { settingsIpc } = renderSettings();
    await waitForLoaded();
    fireEvent.click(tabByLabel('Shortcuts'));

    const pause = screen.getByRole('switch', { name: 'Pause global shortcuts' });
    fireEvent.click(pause);
    await waitFor(() => expect(settingsIpc.setShortcutsPaused).toHaveBeenCalledWith(true));
    expect(await screen.findByText(/Global shortcuts are paused/i)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Change' })[0]);
    const capture = await screen.findByRole('group', { name: 'Capture Dictation shortcut' });
    fireEvent.keyDown(capture, { code: 'Backspace', key: 'Backspace' });

    await waitFor(() => expect(settingsIpc.setConfig).toHaveBeenCalledWith(
      'shortcuts',
      expect.objectContaining({ dictation: expect.objectContaining({ binding: null }) }),
    ));
  });

  it('shows agent provider controls on the Agent section', async () => {
    renderSettings();
    await waitForLoaded();

    fireEvent.click(tabByLabel('Agent'));

    expect(screen.getByRole('switch', { name: 'Enable Agent Mode' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Provider base URL' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Model' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Thinking' })).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'API key env var name' }),
    ).toBeInTheDocument();
  });

  it('shows a saved credential as replaceable without repopulating its value', async () => {
    const config = baseConfig();
    renderSettings({
      config: {
        ...config,
        agent: {
          ...config.agent,
          provider: { ...config.agent.provider, apiKeySource: 'stored' },
        },
      },
      credentialStatus: { available: true, exists: true },
    });
    await waitForLoaded();

    fireEvent.click(tabByLabel('Agent'));

    const input = await screen.findByLabelText('Saved API key');
    expect(input).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove key' })).toBeInTheDocument();
    expect(screen.getByText('Saved securely')).toBeInTheDocument();
  });

  it('shows update controls on the About section', async () => {
    renderSettings();
    await waitForLoaded();

    fireEvent.click(tabByLabel('About'));

    expect(screen.getByText('Version')).toBeInTheDocument();
    expect(screen.getByText('Update status')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Check for Updates' }),
    ).toBeInTheDocument();
  });

  it('exposes MCP server configuration on the MCP Servers section', async () => {
    renderSettings();
    await waitForLoaded();

    fireEvent.click(tabByLabel('MCP Servers'));

    expect(
      screen.getByRole('button', { name: 'Save Server' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Transport' })).toBeInTheDocument();
  });

  it('exposes the agent run history on the History section', async () => {
    renderSettings({ auditRuns: [] });
    await waitForLoaded();

    fireEvent.click(tabByLabel('History'));

    expect(screen.getByRole('listbox', { name: 'Agent run history' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Refresh agent history' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('No agent runs recorded yet.'),
    ).toBeInTheDocument();
  });

  it('shows the first-run setup checklist on Transcription until dismissed', async () => {
    renderSettings({ config: baseConfig({ setupChecklistDismissed: false }) });
    await waitForLoaded();

    expect(screen.getByRole('region', { name: 'First-run setup' })).toBeInTheDocument();
    expect(
      screen.getByText('Set Whisper endpoint'),
    ).toBeInTheDocument();
    expect(screen.getByText('Try a dictation (Ctrl + Win)')).toBeInTheDocument();
  });

  it('dismisses the first-run setup checklist through config persistence', async () => {
    const { settingsIpc } = renderSettings({
      config: baseConfig({ setupChecklistDismissed: false }),
    });
    await waitForLoaded();

    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss setup checklist' }),
    );

    await waitFor(() => {
      expect(settingsIpc.setConfig).toHaveBeenCalledWith(
        'setupChecklistDismissed',
        true,
      );
    });
    expect(
      screen.queryByRole('region', { name: 'First-run setup' }),
    ).toBeNull();
  });

  it('confirms before disabling Agent Mode', async () => {
    const config = baseConfig();
    const { settingsIpc } = renderSettings({
      config: { ...config, agent: { ...config.agent, enabled: true } },
    });
    await waitForLoaded();
    fireEvent.click(tabByLabel('Agent'));

    fireEvent.click(screen.getByRole('switch', { name: 'Enable Agent Mode' }));
    expect(
      screen.getByRole('alertdialog', { name: 'Disable Agent Mode?' }),
    ).toBeInTheDocument();
    expect(settingsIpc.setConfig).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(settingsIpc.setConfig).not.toHaveBeenCalled();
  });
});

describe('Settings persistence timing', () => {
  it('commits safe toggles immediately', async () => {
    const { settingsIpc } = renderSettings();
    await waitForLoaded();

    fireEvent.click(screen.getByRole('switch', { name: 'Clean transcription' }));

    await waitFor(() => {
      expect(settingsIpc.setConfig).toHaveBeenCalledWith(
        'removeFillerWords',
        false,
      );
    });
  });

  it('commits safe selections immediately', async () => {
    const { settingsIpc } = renderSettings();
    await waitForLoaded();
    fireEvent.click(tabByLabel('Shortcuts'));

    const activation = screen.getByRole('combobox', {
      name: 'Dictation activation mode',
    });
    fireEvent.change(activation, { target: { value: 'toggle' } });

    await waitFor(() => {
      expect(settingsIpc.setConfig).toHaveBeenCalledWith(
        'shortcuts',
        expect.objectContaining({
          dictation: expect.objectContaining({ activationMode: 'toggle' }),
          agent: expect.objectContaining({ activationMode: 'push-to-talk' }),
        }),
      );
    });
  });

  it('keeps text changes as a draft until blur', async () => {
    const { settingsIpc } = renderSettings();
    await waitForLoaded();
    fireEvent.click(tabByLabel('Agent'));

    const model = screen.getByRole('textbox', { name: 'Model' });
    fireEvent.change(model, { target: { value: 'local/new-model' } });
    expect(settingsIpc.setConfig).not.toHaveBeenCalled();

    fireEvent.blur(model);

    await waitFor(() => {
      expect(settingsIpc.setConfig).toHaveBeenCalledWith(
        'agent',
        expect.objectContaining({
          provider: expect.objectContaining({ model: 'local/new-model' }),
        }),
      );
    });
  });
});

describe('Settings save feedback', () => {
  it('announces a successful commit in one in-window notification', async () => {
    renderSettings();
    await waitForLoaded();

    fireEvent.click(screen.getByRole('switch', { name: 'Clean transcription' }));

    const notification = await screen.findByRole('status');
    expect(notification).toHaveTextContent('Settings saved');
  });

  it('coalesces rapid successful commits into one notification', async () => {
    renderSettings();
    await waitForLoaded();

    const cleanToggle = screen.getByRole('switch', {
      name: 'Clean transcription',
    });
    fireEvent.click(cleanToggle);
    fireEvent.click(cleanToggle);

    await screen.findByRole('status');
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('removes successful feedback after the bounded display time', async () => {
    renderSettings();
    await waitForLoaded();
    const timers: Array<{ callback: () => void; delay?: number }> = [];
    const setTimeoutSpy = spyOn(window, 'setTimeout').mockImplementation(
      (callback: TimerHandler, delay?: number) => {
        if (typeof callback === 'function') {
          timers.push({ callback: callback as () => void, delay });
        }
        return timers.length as unknown as number;
      },
    );

    try {
      await act(async () => {
        fireEvent.click(
          screen.getByRole('switch', { name: 'Clean transcription' }),
        );
        await Promise.resolve();
      });
      expect(screen.getByRole('status')).toHaveTextContent('Settings saved');

      const dismissTimer = timers.find((timer) => timer.delay === 2500);
      expect(dismissTimer).toBeDefined();
      act(() => dismissTimer?.callback());

      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('keeps save failures visible beside the affected control', async () => {
    renderSettings({ failSetConfig: true });
    await waitForLoaded();

    const cleanToggle = screen.getByRole('switch', {
      name: 'Clean transcription',
    });
    fireEvent.click(cleanToggle);

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Could not save this setting.');
    expect(cleanToggle).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Settings validation', () => {
  it('validates the local endpoint on blur without persisting an invalid draft', async () => {
    const { settingsIpc } = renderSettings();
    await waitForLoaded();
    const endpoint = screen.getByRole('textbox', { name: 'Endpoint' });

    fireEvent.change(endpoint, { target: { value: 'not a url' } });
    expect(screen.queryByText(/Enter a valid URL/)).toBeNull();
    expect(settingsIpc.setConfig).not.toHaveBeenCalled();

    fireEvent.blur(endpoint);

    const error = await screen.findByText(/Enter a valid URL/);
    expect(error).toBeInTheDocument();
    expect(endpoint).toHaveAttribute('aria-invalid', 'true');
    expect(endpoint).toHaveAttribute('aria-describedby', error.id);
    expect(settingsIpc.setConfig).not.toHaveBeenCalled();
  });

  it('commits a valid local provider endpoint on blur', async () => {
    const { settingsIpc } = renderSettings();
    await waitForLoaded();
    const endpoint = screen.getByRole('textbox', { name: 'Endpoint' });

    fireEvent.change(endpoint, {
      target: { value: 'http://127.0.0.1:9090/inference' },
    });
    fireEvent.blur(endpoint);

    await waitFor(() => {
      expect(settingsIpc.setConfig).toHaveBeenCalledWith(
        'transcription',
        {
          activeProvider: 'local-whisper-cpp',
          providers: {
            localWhisperCpp: { endpoint: 'http://127.0.0.1:9090/inference' },
            openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
            azureSpeech: { endpoint: '', region: '' },
            googleCloudSpeech: { project: '', location: 'global', model: '', credentialSource: 'service-account' },
            nvidiaSpeechNim: { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
            customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
          },
        },
      );
    });
    expect(screen.queryByText(/Enter a valid URL/)).toBeNull();
  });
});
