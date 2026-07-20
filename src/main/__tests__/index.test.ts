import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';
import type { DictationTargetSnapshot } from '../../types/ipc';

const vi = { fn: mock, mock: mock.module, spyOn };

const ipcHandlers = new Map<string, (...args: any[]) => unknown>();
const ipcListeners = new Map<string, (...args: any[]) => unknown>();
const appListeners = new Map<string, (...args: any[]) => unknown>();
const clipboardText = { value: 'original' };
const send = vi.fn();
const isDestroyed = vi.fn(() => false);
const showRecordingPill = vi.fn();
const hideRecordingPill = vi.fn();
const getRecordingPillWindow = vi.fn(() => ({
  webContents: { send },
  isDestroyed,
}));
const setConfig = vi.fn();
const mergeDiscoveredTools = vi.fn();
const getConfig = vi.fn(() => ({
  whisperUrl: 'http://localhost:8080/inference',
  transcription: {
    activeProvider: 'local-whisper-cpp',
    providers: {
      localWhisperCpp: { endpoint: 'http://localhost:8080/inference' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
      customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
    },
  },
  selectedDeviceId: null,
  removeFillerWords: true,
  language: 'auto',
  task: 'transcribe',
  dictionary: [],
  pasteStrategy: { default: 'ctrl-v', overrides: {} },
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
}));
const simulatePaste = vi.fn(() => ({ acceptedEvents: 4 }));
const getClipboardSequenceNumber = vi.fn(() => 1);
const defaultTargetSnapshot: DictationTargetSnapshot = {
  hwnd: 12345,
  processId: 67890,
  threadId: 111,
  windowClass: 'Notepad',
  executablePath: 'C:\\Windows\\notepad.exe',
  capturedAt: '2026-01-01T00:00:00.000Z',
};
const captureForegroundTarget = vi.fn(() => defaultTargetSnapshot);
const checkForUpdates = vi.fn();
const getUpdateStatus = vi.fn(() => ({
  state: 'idle',
  currentVersion: '4.0.0',
  message: 'Shuddhalekhan v4.0.0',
  checkedAt: null,
}));
const updateAudioDevices = vi.fn();
const updateUpdaterStatus = vi.fn();
let trayHandlers: { onOpenSettings?: () => void; onPasteLastTranscript?: () => void; onCopyLastTranscript?: () => void; onSelectDevice?: (deviceId: string) => void } = {};
let notificationShow: ReturnType<typeof vi.fn>;
const openSettingsWindow = vi.fn();
const getSettingsWindow = vi.fn(() => ({
  webContents: { send },
  isDestroyed: vi.fn(() => false),
}));

const keyboardStart = vi.fn();
const keyboardStop = vi.fn();
const agentStartRun = vi.fn();
const agentStart = vi.fn();
const agentStop = vi.fn();
const agentCancelRun = vi.fn();
const agentSendApprovalDecision = vi.fn();
const credentialVault = { read: vi.fn(() => null) };
const registerCredentialIpcHandlers = vi.fn();
const showAgentToast = vi.fn();
const hideAgentToast = vi.fn();
const handleAgentToastContentSize = vi.fn();
let agentEventHandler: ((event: any) => void) | null = null;

// Mock RecordingSession
const recordingSessionStart = vi.fn();
const recordingSessionStop = vi.fn();
const recordingSessionBegin = vi.fn();
const recordingSessionEnd = vi.fn(() => Promise.resolve({ text: 'transcribed text', intent: 'dictation', targetSnapshot: null }));
const recordingSessionUpdateDevice = vi.fn();
const recordingSessionGetAudioWebContents = vi.fn();
let sessionOptions: any = null;

installElectronMock();
mock.module('../native/keyboard', () => ({
  keyboardHook: { start: keyboardStart, stop: keyboardStop },
}));
mock.module('../native/clipboard', () => ({
  simulatePaste,
  getClipboardSequenceNumber,
}));
mock.module('../native/target', () => ({ captureForegroundTarget }));
mock.module('../recording-pill', () => ({ showRecordingPill, hideRecordingPill, getRecordingPillWindow }));
mock.module('../settings-window', () => ({ getSettingsWindow, openSettingsWindow }));
mock.module('../tray', () => ({
  createTray: vi.fn((handlers: typeof trayHandlers) => {
    trayHandlers = handlers;
  }),
  updateAudioDevices,
  updateUpdaterStatus,
}));
mock.module('../config', () => ({ getConfig, setConfig, mergeDiscoveredTools }));
mock.module('../credential-vault', () => ({ credentialVault }));
mock.module('../credential-ipc', () => ({ registerCredentialIpcHandlers }));
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
    cancelRun = agentCancelRun;
    sendApprovalDecision = agentSendApprovalDecision;
  },
}));
mock.module('../recording-session', () => ({
  RecordingSession: class {
    constructor(options: any) {
      sessionOptions = options;
    }
    start = recordingSessionStart;
    stop = recordingSessionStop;
    begin = recordingSessionBegin;
    end = recordingSessionEnd;
    updateDevice = recordingSessionUpdateDevice;
    getAudioWebContents = recordingSessionGetAudioWebContents;
  }
}));

describe('main process IPC orchestration', () => {
  const baseConfig = {
    whisperUrl: 'http://localhost:8080/inference',
    transcription: {
      activeProvider: 'local-whisper-cpp',
      providers: {
        localWhisperCpp: { endpoint: 'http://localhost:8080/inference' },
        openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
        customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
      },
    },
    selectedDeviceId: null,
    removeFillerWords: true,
    language: 'auto',
    task: 'transcribe',
    dictionary: [],
    pasteStrategy: { default: 'ctrl-v', overrides: {} },
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
  };

  afterAll(() => {
    mock.restore();
  });

  beforeEach(async () => {
    ipcHandlers.clear();
    ipcListeners.clear();
    appListeners.clear();
    trayHandlers = {};
    clipboardText.value = 'original';
    resetElectronMock();
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))) as typeof fetch;
    notificationShow = vi.fn();
    electronMock.Notification.mockImplementation(() => ({ show: notificationShow }));
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
    electronMock.clipboard.availableFormats.mockReturnValue(['text/plain']);
    electronMock.clipboard.writeText.mockImplementation((text: string) => {
      clipboardText.value = text;
    });
    send.mockClear();
    isDestroyed.mockReturnValue(false);
    showRecordingPill.mockClear();
    hideRecordingPill.mockClear();
    setConfig.mockClear();
    getConfig.mockClear();
    mergeDiscoveredTools.mockClear();
    simulatePaste.mockReset();
    simulatePaste.mockReturnValue({ acceptedEvents: 4 });
    getClipboardSequenceNumber.mockReset();
    getClipboardSequenceNumber.mockReturnValue(1);
    captureForegroundTarget.mockReset();
    captureForegroundTarget.mockReturnValue(defaultTargetSnapshot);
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
    agentCancelRun.mockClear();
    agentSendApprovalDecision.mockClear();
    showAgentToast.mockClear();
    hideAgentToast.mockClear();
    handleAgentToastContentSize.mockClear();
    agentEventHandler = null;
    getConfig.mockReturnValue(baseConfig);

    recordingSessionStart.mockClear();
    recordingSessionStop.mockClear();
    recordingSessionBegin.mockClear();
    recordingSessionEnd.mockClear();
    recordingSessionUpdateDevice.mockClear();
    recordingSessionGetAudioWebContents.mockClear();
    sessionOptions = null;

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
      'audit:get-run-detail',
      'audit:get-runs',
      'clipboard:inject-text',
      'config:get',
      'config:set',
      'mcp:test-server',
      'settings:open',
      'transcription:check-server',
      'updater:check',
      'updater:get-status',
    ]);
    expect([...ipcListeners.keys()].sort()).toEqual([
      'agent-toast:content-size',
      'agent-toast:dismiss',
      'audio-devices',
    ]);
  });

  it('shows transcription failures through a sanitized non-blocking toast', () => {
    sessionOptions.onError(new Error('token=super-secret'));

    expect(showAgentToast).toHaveBeenCalledWith({
      kind: 'transcription-failed',
      message: 'Transcription failed unexpectedly. Check provider settings and try again.',
    });
    expect(electronMock.dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it('checks the configured local endpoint without audio', async () => {
    await expect(ipcHandlers.get('transcription:check-server')?.({})).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith('http://localhost:8080/inference', { method: 'HEAD' });
  });

  it('starts recording when audio:start-recording is invoked', () => {
    ipcHandlers.get('audio:start-recording')?.({});
    expect(recordingSessionBegin).toHaveBeenCalledWith('dictation');
  });

  it('stops recording when audio:stop-recording is invoked', async () => {
    await ipcHandlers.get('audio:stop-recording')?.({});
    expect(recordingSessionEnd).toHaveBeenCalled();
  });

  it('transcribes completed audio and restores the clipboard after paste', async () => {
    // Simulate successful result callback
    const result = {
      text: 'transcribed text',
      intent: 'dictation' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(simulatePaste).toHaveBeenCalled();
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

    // Re-import index to pick up agent enabled configuration
    await import(`../index?test=${Date.now()}-agent-routes`);
    
    const result = {
      text: 'transcribed text',
      intent: 'agent' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);

    expect(agentStartRun).toHaveBeenCalledWith(expect.any(String), 'transcribed text', config, undefined);
    expect(simulatePaste).not.toHaveBeenCalled();
  });

  it('routes dictation recordings through clipboard injection and not the agent sidecar', async () => {
    const result = {
      text: 'transcribed text',
      intent: 'dictation' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(agentStartRun).not.toHaveBeenCalled();
    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith('transcribed text');
  });

  it('shows a config toast instead of starting the sidecar when Agent Mode is disabled', async () => {
    const result = {
      text: 'transcribed text',
      intent: 'agent' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);

    expect(agentStartRun).not.toHaveBeenCalled();
    expect(showAgentToast).toHaveBeenCalledWith({
      kind: 'config',
      message: 'Agent Mode is disabled. Open Settings to enable it.',
    });
  });

  it('shows explicit approval status and approval toast when a tool asks for HITL', async () => {
    const config = { ...baseConfig, agent: { ...baseConfig.agent, enabled: true } };
    getConfig.mockReturnValue(config);

    // Re-import to pick up config change
    await import(`../index?test=${Date.now()}-hitl-toast`);

    const result = {
      text: 'transcribed text',
      intent: 'agent' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);
    const activeRunId = agentStartRun.mock.calls[0]?.[0] as string;
    showAgentToast.mockClear();

    agentEventHandler?.({
      type: 'approval:requested',
      agentRunId: activeRunId,
      approvalId: 'approval-1',
      serverId: 'exa',
      toolName: 'web_search_exa',
      modelToolName: 'exa__web_search_exa',
      arguments: { query: 'current events' },
      expiresAt: '2026-05-09T16:35:24.399Z',
    });

    expect(showAgentToast).toHaveBeenNthCalledWith(1, {
      kind: 'status',
      agentRunId: activeRunId,
      message: 'Waiting for approval: exa.web_search_exa',
    });
    expect(showAgentToast).toHaveBeenNthCalledWith(2, {
      kind: 'approval',
      agentRunId: activeRunId,
      approvalId: 'approval-1',
      serverId: 'exa',
      toolName: 'web_search_exa',
      modelToolName: 'exa__web_search_exa',
      arguments: { query: 'current events' },
      expiresAt: '2026-05-09T16:35:24.399Z',
    });
  });

  it('proxies config, device, update, and recording pill events without restarting sidecar for audio config', async () => {
    recordingSessionGetAudioWebContents.mockReturnValue({ send: vi.fn() });
    
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
    ipcListeners.get('agent-toast:content-size')?.({}, 280);
    ipcListeners.get('agent-toast:dismiss')?.({});

    expect(setConfig).toHaveBeenCalledWith('whisperUrl', 'http://new');
    expect(agentStart).not.toHaveBeenCalled();
    expect(agentStop).not.toHaveBeenCalled();
    expect(openSettingsWindow).toHaveBeenCalled();
    expect(agentSendApprovalDecision).toHaveBeenCalledWith('run-1', 'approval-1', 'denied', 'no');
    expect(hideAgentToast).toHaveBeenCalled();
    expect(setConfig).toHaveBeenCalledWith('selectedDeviceId', 'mic-1');
    expect(recordingSessionUpdateDevice).toHaveBeenCalledWith('mic-1');
    expect(checkForUpdates).toHaveBeenCalled();
    expect(updateAudioDevices).toHaveBeenCalledWith([{ deviceId: 'mic-1', label: 'Mic', kind: 'audioinput' }]);
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
    expect(agentStart).toHaveBeenCalledWith(enabledConfig, undefined);

    getConfig.mockReturnValueOnce(enabledConfig).mockReturnValueOnce(baseConfig);
    ipcHandlers.get('config:set')?.({}, 'agent', baseConfig.agent);
    expect(agentStop).toHaveBeenCalled();
  });

  it('stops recording session before quit', () => {
    appListeners.get('before-quit')?.();

    expect(recordingSessionStop).toHaveBeenCalledTimes(1);
    expect(agentStop).toHaveBeenCalledTimes(1);
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

  it('stores the last transcript before injection so it survives paste failures', async () => {
    simulatePaste.mockReturnValue({ acceptedEvents: 0, errorCode: 5 });

    const result = {
      text: 'transcribed text',
      intent: 'dictation' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(electronMock.dialog.showErrorBox).not.toHaveBeenCalled();
    expect(notificationShow).toHaveBeenCalledTimes(1);

    simulatePaste.mockReturnValue({ acceptedEvents: 4 });
    await trayHandlers.onPasteLastTranscript?.();

    expect(simulatePaste).toHaveBeenCalled();
  });

  it('does not show a recovery notification when automatic paste succeeds', async () => {
    const result = {
      text: 'transcribed text',
      intent: 'dictation' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(notificationShow).not.toHaveBeenCalled();
    expect(electronMock.dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it('copies the last transcript from the tray without sending synthetic input', async () => {
    const result = {
      text: 'transcribed text',
      intent: 'dictation' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);
    await new Promise((resolve) => setTimeout(resolve, 500));

    simulatePaste.mockClear();
    await trayHandlers.onCopyLastTranscript?.();

    expect(electronMock.clipboard.writeText).toHaveBeenLastCalledWith('transcribed text');
    expect(simulatePaste).not.toHaveBeenCalled();
  });

  it('notifies when tray paste-last-transcript fails again', async () => {
    const result = {
      text: 'transcribed text',
      intent: 'dictation' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);
    await new Promise((resolve) => setTimeout(resolve, 500));

    notificationShow.mockClear();
    simulatePaste.mockReturnValue({ acceptedEvents: 0, errorCode: 5 });
    await trayHandlers.onPasteLastTranscript?.();

    expect(notificationShow).toHaveBeenCalledTimes(1);
  });

  it('shows a distinct recovery notification when the clipboard changes during dictation', async () => {
    getClipboardSequenceNumber.mockReturnValueOnce(1).mockReturnValueOnce(2);

    const result = {
      text: 'transcribed text',
      intent: 'dictation' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(notificationShow).toHaveBeenCalledTimes(1);
    expect(electronMock.Notification).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('Clipboard changed during dictation'),
      })
    );
  });
});
