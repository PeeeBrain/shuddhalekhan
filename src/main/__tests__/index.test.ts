import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

const vi = { fn: mock, mock: mock.module, spyOn };

const ipcHandlers = new Map<string, (...args: any[]) => unknown>();
const ipcListeners = new Map<string, (...args: any[]) => unknown>();
const appListeners = new Map<string, (...args: any[]) => unknown>();
const clipboardText = { value: 'original' };
const send = vi.fn();
const isLoading = vi.fn(() => false);
const isDestroyed = vi.fn(() => false);
const createAudioWindow = vi.fn(() => ({
  webContents: { send, isLoading, on: vi.fn() },
  isDestroyed,
}));
const getAudioWindow = vi.fn(() => ({
  webContents: { send, isLoading },
  isDestroyed,
}));
const destroyAudioWindow = vi.fn();
const showRecordingPill = vi.fn();
const hideRecordingPill = vi.fn();
const getRecordingPillWindow = vi.fn(() => ({
  webContents: { send },
  isDestroyed,
}));
const setConfig = vi.fn();
const getConfig = vi.fn(() => ({
  whisperUrl: 'http://localhost:8080/inference',
  selectedDeviceId: null,
  removeFillerWords: true,
  agent: {
    enabled: false,
    provider: {
      baseUrl: '',
      model: '',
      apiKeyEnvVar: '',
      thinkingEnabled: true,
    },
    mcpServers: [],
  },
  shortcuts: {
    dictation: {
      action: 'dictation',
      accelerator: 'Control+Meta',
      triggerMode: 'hold',
      status: 'unassigned',
    },
    agent: {
      action: 'agent',
      accelerator: 'Alt+Meta',
      triggerMode: 'hold',
      status: 'unassigned',
    },
  },
}));
const simulatePaste = vi.fn();
const checkForUpdates = vi.fn();
const getUpdateStatus = vi.fn(() => ({
  state: 'idle',
  currentVersion: '4.0.0',
  message: 'Shuddhalekhan v4.0.0',
  checkedAt: null,
}));
const updateAudioDevices = vi.fn();
const updateUpdaterStatus = vi.fn();
const openSettingsWindow = vi.fn();
const getSettingsWindow = vi.fn(() => ({
  webContents: { send },
  isDestroyed: vi.fn(() => false),
}));
const keyboardStart = vi.fn();
const keyboardStop = vi.fn();
const agentStartRun = vi.fn(() => 'run-1');
const agentStart = vi.fn();
const agentStop = vi.fn();
const agentGetActiveAgentRunId = vi.fn(() => null);
const agentSendApprovalDecision = vi.fn();
const showAgentToast = vi.fn();
const hideAgentToast = vi.fn();
const handleAgentToastContentSize = vi.fn();
let agentEventHandler: ((event: any) => void) | null = null;

installElectronMock();
mock.module('../native/keyboard', () => ({
  keyboardHook: { start: keyboardStart, stop: keyboardStop },
}));
mock.module('../native/clipboard', () => ({ simulatePaste }));
mock.module('../audio-window', () => ({ createAudioWindow, getAudioWindow, destroyAudioWindow }));
mock.module('../recording-pill', () => ({ showRecordingPill, hideRecordingPill, getRecordingPillWindow }));
mock.module('../settings-window', () => ({ getSettingsWindow, openSettingsWindow }));
mock.module('../tray', () => ({ createTray: vi.fn(), updateAudioDevices, updateUpdaterStatus }));
mock.module('../config', () => ({ getConfig, setConfig }));
mock.module('../platform', () => ({
  createPlatformProvider: () => ({
    getCapabilities: vi.fn(() => ({
      platform: 'win32',
      desktop: 'windows',
      shortcuts: {
        dictation: { state: 'ready', message: 'Ready.' },
        agent: { state: 'ready', message: 'Ready.' },
      },
      textInjection: { state: 'ready', message: 'Ready.' },
    })),
  }),
  createPlatformProviderForTest: (platform: 'win32' | 'darwin' | 'linux', env?: NodeJS.ProcessEnv) => ({
    getCapabilities: vi.fn(() => {
      if (platform === 'darwin') {
        return {
          platform,
          desktop: 'macos',
          shortcuts: {
            dictation: { state: 'unassigned', message: 'Record a macOS shortcut in Settings.' },
            agent: { state: 'unassigned', message: 'Record a macOS shortcut in Settings.' },
          },
          textInjection: { state: 'needsSetup', message: 'macOS may require Accessibility permission.' },
        };
      }
      if (platform === 'linux') {
        const isGnomeWayland = env?.XDG_CURRENT_DESKTOP === 'GNOME' && env?.XDG_SESSION_TYPE === 'wayland';
        return {
          platform,
          desktop: isGnomeWayland ? 'gnome-wayland' : 'linux-unknown',
          shortcuts: {
            dictation: { state: isGnomeWayland ? 'needsSetup' : 'unsupported', message: 'Linux shortcut setup required.' },
            agent: { state: isGnomeWayland ? 'needsSetup' : 'unsupported', message: 'Linux shortcut setup required.' },
          },
          textInjection: { state: 'unsupported', message: 'Paste simulation is not verified.' },
        };
      }
      return {
        platform,
        desktop: 'windows',
        shortcuts: {
          dictation: { state: 'ready', message: 'Ready.' },
          agent: { state: 'ready', message: 'Ready.' },
        },
        textInjection: { state: 'ready', message: 'Ready.' },
      };
    }),
  }),
}));
mock.module('../updater', () => ({ setupUpdater: vi.fn(), checkForUpdates, getUpdateStatus }));
mock.module('../agent-toast-window', () => ({ showAgentToast, hideAgentToast, handleAgentToastContentSize }));
mock.module('../agent-sidecar', () => ({
  AgentSidecarManager: class {
    constructor(onEvent: (event: any) => void) {
      agentEventHandler = onEvent;
    }
    start = agentStart;
    startRun = agentStartRun;
    stop = agentStop;
    getActiveAgentRunId = agentGetActiveAgentRunId;
    sendApprovalDecision = agentSendApprovalDecision;
  },
}));

describe('main process IPC orchestration', () => {
  const baseConfig = {
    whisperUrl: 'http://localhost:8080/inference',
    selectedDeviceId: null,
    removeFillerWords: true,
    agent: {
      enabled: false,
      provider: {
        baseUrl: '',
        model: '',
        apiKeyEnvVar: '',
        thinkingEnabled: true,
      },
      mcpServers: [],
    },
    shortcuts: {
      dictation: {
        action: 'dictation',
        accelerator: 'Control+Meta',
        triggerMode: 'hold',
        status: 'unassigned',
      },
      agent: {
        action: 'agent',
        accelerator: 'Alt+Meta',
        triggerMode: 'hold',
        status: 'unassigned',
      },
    },
  };

  afterAll(() => {
    mock.restore();
  });

  beforeEach(async () => {
    ipcHandlers.clear();
    ipcListeners.clear();
    appListeners.clear();
    clipboardText.value = 'original';
    resetElectronMock();
    electronMock.app.on.mockImplementation((event: string, listener: (...args: any[]) => void) => {
      appListeners.set(event, listener);
    });
    electronMock.BrowserWindow.mockImplementation(() => ({
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      webContents: { send },
    }));
    electronMock.ipcMain.handle.mockImplementation((channel: string, handler: (...args: any[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    });
    electronMock.ipcMain.on.mockImplementation((channel: string, listener: (...args: any[]) => unknown) => {
      ipcListeners.set(channel, listener);
    });
    electronMock.clipboard.readText.mockImplementation(() => clipboardText.value);
    electronMock.clipboard.writeText.mockImplementation((text: string) => {
      clipboardText.value = text;
    });
    send.mockClear();
    isLoading.mockReturnValue(false);
    isDestroyed.mockReturnValue(false);
    createAudioWindow.mockClear();
    getAudioWindow.mockClear();
    destroyAudioWindow.mockClear();
    showRecordingPill.mockClear();
    hideRecordingPill.mockClear();
    setConfig.mockClear();
    getConfig.mockClear();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: 'transcribed text' }),
    })) as unknown as typeof fetch;
    simulatePaste.mockClear();
    checkForUpdates.mockClear();
    getUpdateStatus.mockClear();
    updateAudioDevices.mockClear();
    updateUpdaterStatus.mockClear();
    openSettingsWindow.mockClear();
    getSettingsWindow.mockClear();
    keyboardStart.mockClear();
    keyboardStop.mockClear();
    agentStartRun.mockClear();
    agentStart.mockClear();
    agentStop.mockClear();
    agentGetActiveAgentRunId.mockClear();
    agentSendApprovalDecision.mockClear();
    showAgentToast.mockClear();
    hideAgentToast.mockClear();
    handleAgentToastContentSize.mockClear();
    agentEventHandler = null;
    getConfig.mockReturnValue(baseConfig);
    await import(`../index?test=${Date.now()}-${Math.random()}`);
  });

  it('registers the expected IPC handlers and listeners', () => {
    expect([...ipcHandlers.keys()].sort()).toEqual([
      'agent:approval-decision',
      'app:get-info',
      'audio:get-devices',
      'audio:select-device',
      'audio:start-recording',
      'audio:stop-recording',
      'clipboard:inject-text',
      'config:get',
      'config:set',
      'mcp:test-server',
      'platform:get-capabilities',
      'settings:open',
      'shortcuts:get',
      'shortcuts:save',
      'shortcuts:validate',
      'updater:check',
      'updater:get-status',
    ]);
    expect([...ipcListeners.keys()].sort()).toEqual([
      'agent-toast:content-size',
      'audio-data-ready',
      'audio-devices',
      'audio-duration-changed',
      'audio-level-changed',
      'audio-window-ready',
    ]);
  });

  it('starts recording immediately when the audio window is ready', () => {
    ipcListeners.get('audio-window-ready')?.({});
    ipcHandlers.get('audio:start-recording')?.({});

    expect(createAudioWindow).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('audio:start-recording');
    expect(showRecordingPill).toHaveBeenCalled();
  });

  it('queues start until the hidden audio window reports readiness', () => {
    isLoading.mockReturnValue(true);

    ipcHandlers.get('audio:start-recording')?.({});
    expect(send).not.toHaveBeenCalledWith('audio:start-recording');

    isLoading.mockReturnValue(false);
    ipcListeners.get('audio-window-ready')?.({});
    expect(send).toHaveBeenCalledWith('audio:start-recording');
  });

  it('stops recording and asks the audio window for buffered audio', async () => {
    ipcListeners.get('audio-window-ready')?.({});
    ipcHandlers.get('audio:start-recording')?.({});

    await ipcHandlers.get('audio:stop-recording')?.({});

    expect(hideRecordingPill).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('audio:stop-recording');
  });

  it('transcribes completed audio and restores the clipboard after paste', async () => {
    ipcListeners.get('audio-window-ready')?.({});
    ipcHandlers.get('audio:start-recording')?.({});
    await ipcHandlers.get('audio:stop-recording')?.({});

    const listenerPromise = ipcListeners.get('audio-data-ready')?.({}, new Uint8Array(64).buffer) as Promise<void>;
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(simulatePaste).toHaveBeenCalled();
    await listenerPromise;
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(fetch).toHaveBeenCalledWith('http://localhost:8080/inference', expect.objectContaining({
      method: 'POST',
      body: expect.any(FormData),
    }));
    expect(electronMock.clipboard.writeText).toHaveBeenNthCalledWith(1, 'transcribed text');
    expect(electronMock.clipboard.writeText).toHaveBeenLastCalledWith('original');
  });

  it('routes agent recordings to the sidecar without injecting text', async () => {
    const config = {
      whisperUrl: 'http://localhost:8080/inference',
      selectedDeviceId: null,
      removeFillerWords: true,
      agent: {
        enabled: true,
        provider: {
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'openai/gpt-4.1-mini',
          apiKeyEnvVar: 'OPENROUTER_API_KEY',
          thinkingEnabled: true,
        },
        mcpServers: [],
      },
    };
    getConfig.mockReturnValue(config);
    ipcListeners.get('audio-window-ready')?.({});
    const [onStart, onStop] = keyboardStart.mock.calls[0] as [(intent: 'dictation' | 'agent') => void, () => void];
    onStart('agent');
    onStop();

    const listenerPromise = ipcListeners.get('audio-data-ready')?.({}, new Uint8Array(64).buffer) as Promise<void>;
    await listenerPromise;

    expect(showRecordingPill).toHaveBeenCalledWith('agent');
    expect(agentStartRun).toHaveBeenCalledWith('transcribed text', config);
    expect(simulatePaste).not.toHaveBeenCalled();
  });

  it('routes dictation recordings through clipboard injection and not the agent sidecar', async () => {
    ipcListeners.get('audio-window-ready')?.({});
    const [onStart, onStop] = keyboardStart.mock.calls[0] as [(intent: 'dictation' | 'agent') => void, () => void];
    onStart('dictation');
    onStop();

    const listenerPromise = ipcListeners.get('audio-data-ready')?.({}, new Uint8Array(64).buffer) as Promise<void>;
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(simulatePaste).toHaveBeenCalled();
    await listenerPromise;

    expect(showRecordingPill).toHaveBeenCalledWith('dictation');
    expect(agentStartRun).not.toHaveBeenCalled();
    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith('transcribed text');
  });

  it('shows a config toast instead of starting the sidecar when Agent Mode is disabled', async () => {
    ipcListeners.get('audio-window-ready')?.({});
    const [onStart, onStop] = keyboardStart.mock.calls[0] as [(intent: 'dictation' | 'agent') => void, () => void];
    onStart('agent');
    onStop();

    await ipcListeners.get('audio-data-ready')?.({}, new Uint8Array(64).buffer);

    expect(agentStartRun).not.toHaveBeenCalled();
    expect(showAgentToast).toHaveBeenCalledWith({
      kind: 'config',
      message: 'Agent Mode is disabled. Open Settings to enable it.',
    });
  });

  it('restores the previous clipboard and warns when paste is blocked', async () => {
    simulatePaste.mockImplementation(() => {
      throw new Error('paste blocked');
    });
    ipcListeners.get('audio-window-ready')?.({});
    const [onStart, onStop] = keyboardStart.mock.calls[0] as [(intent: 'dictation' | 'agent') => void, () => void];
    onStart('dictation');
    onStop();

    await ipcListeners.get('audio-data-ready')?.({}, new Uint8Array(64).buffer);
    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith('transcribed text');
    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith('original');
    expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Paste blocked',
    }));
  });

  it('shows explicit approval status and approval toast when a tool asks for HITL', async () => {
    agentEventHandler?.({
      type: 'approval:requested',
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      serverId: 'exa',
      toolName: 'web_search_exa',
      modelToolName: 'exa__web_search_exa',
      arguments: { query: 'current events' },
      expiresAt: '2026-05-09T16:35:24.399Z',
    });

    expect(showAgentToast).toHaveBeenNthCalledWith(1, {
      kind: 'status',
      agentRunId: 'run-1',
      message: 'Waiting for approval: exa.web_search_exa',
    });
    expect(showAgentToast).toHaveBeenNthCalledWith(2, {
      kind: 'approval',
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      serverId: 'exa',
      toolName: 'web_search_exa',
      modelToolName: 'exa__web_search_exa',
      arguments: { query: 'current events' },
      expiresAt: '2026-05-09T16:35:24.399Z',
    });
  });

  it('skips empty WAV payloads', async () => {
    await ipcListeners.get('audio-data-ready')?.({}, new Uint8Array(44).buffer);

    expect(fetch).not.toHaveBeenCalled();
    expect(simulatePaste).not.toHaveBeenCalled();
  });

  it('proxies config, device, update, and recording pill events without restarting sidecar for audio config', async () => {
    expect(ipcHandlers.get('config:get')?.({})).toEqual(getConfig());
    await expect(ipcHandlers.get('app:get-info')?.({})).resolves.toEqual({
      name: 'Shuddhalekhan',
      version: '4.0.0',
      isPackaged: false,
    });
    expect(ipcHandlers.get('updater:get-status')?.({})).toEqual(getUpdateStatus());
    ipcHandlers.get('config:set')?.({}, 'whisperUrl', 'http://new');
    ipcHandlers.get('mcp:test-server')?.({}, 'missing-server');
    ipcHandlers.get('settings:open')?.({});
    ipcHandlers.get('agent:approval-decision')?.({}, 'run-1', 'approval-1', 'denied', 'no');
    ipcHandlers.get('audio:select-device')?.({}, 'mic-1');
    ipcHandlers.get('updater:check')?.({});
    ipcListeners.get('audio-devices')?.({}, [{ deviceId: 'mic-1', label: 'Mic', kind: 'audioinput' }]);
    ipcListeners.get('audio-level-changed')?.({}, 0.75);
    ipcListeners.get('audio-duration-changed')?.({}, 12);
    ipcListeners.get('agent-toast:content-size')?.({}, 280);

    expect(setConfig).toHaveBeenCalledWith('whisperUrl', 'http://new');
    expect(agentStart).not.toHaveBeenCalled();
    expect(agentStop).not.toHaveBeenCalled();
    expect(openSettingsWindow).toHaveBeenCalled();
    expect(agentSendApprovalDecision).toHaveBeenCalledWith('run-1', 'approval-1', 'denied', 'no');
    expect(hideAgentToast).toHaveBeenCalled();
    expect(setConfig).toHaveBeenCalledWith('selectedDeviceId', 'mic-1');
    expect(send).toHaveBeenCalledWith('audio:select-device', 'mic-1');
    expect(checkForUpdates).toHaveBeenCalled();
    expect(updateAudioDevices).toHaveBeenCalledWith([{ deviceId: 'mic-1', label: 'Mic', kind: 'audioinput' }]);
    expect(send).toHaveBeenCalledWith('audio:level-changed', 0.75);
    expect(send).toHaveBeenCalledWith('audio:duration-changed', 12);
    expect(handleAgentToastContentSize).toHaveBeenCalledWith(280);
  });

  it('applies sidecar lifecycle policy for Agent Mode config changes', () => {
    const enabledConfig = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        enabled: true,
      },
    };

    getConfig.mockReturnValueOnce(baseConfig).mockReturnValueOnce(enabledConfig);
    ipcHandlers.get('config:set')?.({}, 'agent', enabledConfig.agent);
    expect(agentStart).toHaveBeenCalledWith(enabledConfig);

    getConfig.mockReturnValueOnce(enabledConfig).mockReturnValueOnce(baseConfig);
    ipcHandlers.get('config:set')?.({}, 'agent', baseConfig.agent);
    expect(agentStop).toHaveBeenCalled();
  });

  it('stops native hooks and destroys the audio window before quit', () => {
    appListeners.get('before-quit')?.();
    appListeners.get('quit')?.();

    expect(keyboardStop).toHaveBeenCalledTimes(1);
    expect(agentStop).toHaveBeenCalledTimes(1);
    expect(destroyAudioWindow).toHaveBeenCalled();
  });

  it('returns platform capability status', () => {
    const capabilities = ipcHandlers.get('platform:get-capabilities')?.({});

    expect(capabilities).toEqual(expect.objectContaining({
      platform: 'win32',
      shortcuts: expect.objectContaining({
        dictation: expect.objectContaining({ state: 'ready' }),
      }),
    }));
  });

  it('validates and saves shortcut config through IPC', () => {
    const config = getConfig();
    const candidate = {
      action: 'dictation' as const,
      accelerator: 'Control+Space',
      triggerMode: 'toggle' as const,
      status: 'unassigned' as const,
    };

    expect(ipcHandlers.get('shortcuts:get')?.({})).toEqual(config.shortcuts);
    expect(ipcHandlers.get('shortcuts:validate')?.({}, candidate)).toEqual({ ok: true, status: 'ready' });
    ipcHandlers.get('shortcuts:save')?.({}, candidate);

    expect(setConfig).toHaveBeenCalledWith('shortcuts', {
      ...config.shortcuts,
      dictation: { ...candidate, status: 'ready' },
    });
  });

  it('starts the agent sidecar on app ready when persisted Agent Mode is enabled', async () => {
    const config = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        enabled: true,
        provider: {
          baseUrl: 'http://localhost:11434/v1',
          model: 'local-model',
          apiKeyEnvVar: '',
          thinkingEnabled: true,
        },
        mcpServers: [
          {
            id: 'srv1',
            displayName: 'Local MCP',
            enabled: true,
            transport: { type: 'http' as const, url: 'http://localhost:3000/mcp' },
            discoveredTools: [],
            toolPolicies: {},
          },
        ],
      },
    };
    getConfig.mockReturnValue(config);

    await import(`../index?test=${Date.now()}-agent-startup-enabled`);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(agentStart).toHaveBeenCalledWith(config);
  });

  it('does not start the agent sidecar on app ready when Agent Mode is disabled', async () => {
    const config = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        enabled: false,
        mcpServers: [
          {
            id: 'srv1',
            displayName: 'Local MCP',
            enabled: true,
            transport: { type: 'http' as const, url: 'http://localhost:3000/mcp' },
            discoveredTools: [],
            toolPolicies: {},
          },
        ],
      },
    };
    getConfig.mockReturnValue(config);

    await import(`../index?test=${Date.now()}-agent-startup-disabled`);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(agentStart).not.toHaveBeenCalled();
  });
});
