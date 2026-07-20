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
    selectedDeviceId: AUDIO_DEVICES_PLACEHOLDER,
    removeFillerWords: true,
    language: 'auto',
    task: 'transcribe',
    dictionary: [],
    pasteStrategy: { default: 'ctrl-v', overrides: {} },
    setupChecklistDismissed: true,
    recordingActivationMode: 'push-to-talk',
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
  it('shows transcription controls on the Transcription section', async () => {
    renderSettings();
    await waitForLoaded();

    expect(screen.getByRole('switch', { name: 'Clean transcription' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Whisper endpoint' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Spoken language' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Add dictionary word' })).toBeInTheDocument();
  });

  it('shows recording activation and device rows on the Audio section', async () => {
    renderSettings();
    await waitForLoaded();

    fireEvent.click(tabByLabel('Audio'));

    expect(screen.getByRole('combobox', { name: 'Recording activation' })).toBeInTheDocument();
    expect(screen.getByText('Selected device')).toBeInTheDocument();
    expect(screen.getByText('Capture path')).toBeInTheDocument();
  });

  it('shows both hotkey displays on the Shortcuts section', async () => {
    renderSettings();
    await waitForLoaded();

    fireEvent.click(tabByLabel('Shortcuts'));

    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('Dictation')).toBeInTheDocument();
    expect(within(panel).getByText('Agent')).toBeInTheDocument();
    expect(within(panel).getByText('Ctrl').closest('kbd')).toBeInTheDocument();
    expect(within(panel).getByText('Alt').closest('kbd')).toBeInTheDocument();
    expect(panel.querySelectorAll('kbd')).toHaveLength(4);
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
    fireEvent.click(tabByLabel('Audio'));

    const activation = screen.getByRole('combobox', {
      name: 'Recording activation',
    });
    fireEvent.click(activation);
    fireEvent.click(await screen.findByRole('option', { name: 'Toggle recording' }));

    await waitFor(() => {
      expect(settingsIpc.setConfig).toHaveBeenCalledWith(
        'recordingActivationMode',
        'toggle',
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
  it('validates the Whisper URL on blur without persisting an invalid draft', async () => {
    const { settingsIpc } = renderSettings();
    await waitForLoaded();
    const endpoint = screen.getByRole('textbox', { name: 'Whisper endpoint' });

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

  it('commits a valid Whisper URL on blur', async () => {
    const { settingsIpc } = renderSettings();
    await waitForLoaded();
    const endpoint = screen.getByRole('textbox', { name: 'Whisper endpoint' });

    fireEvent.change(endpoint, {
      target: { value: 'http://127.0.0.1:9090/inference' },
    });
    fireEvent.blur(endpoint);

    await waitFor(() => {
      expect(settingsIpc.setConfig).toHaveBeenCalledWith(
        'whisperUrl',
        'http://127.0.0.1:9090/inference',
      );
    });
    expect(screen.queryByText(/Enter a valid URL/)).toBeNull();
  });
});
