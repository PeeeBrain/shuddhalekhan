import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';
import type { DictationTargetSnapshot } from '../../types/ipc';

const vi = { fn: mock, mock: mock.module, spyOn };
const originalSessionType = process.env.XDG_SESSION_TYPE;
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY;
const nativePlatform = process.platform;
// Wayland policy is gated on the platform too; spoofing it keeps these contracts running on Windows CI.
const setPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform });

const ipcHandlers = new Map<string, (...args: any[]) => unknown>();
const ipcListeners = new Map<string, (...args: any[]) => unknown>();
const appListeners = new Map<string, (...args: any[]) => unknown>();
const powerMonitorListeners = new Map<string, (...args: any[]) => unknown>();
const clipboardText = { value: 'original' };
const send = vi.fn();
const isDestroyed = vi.fn(() => false);
const setConfig = vi.fn();
const getLastSeenReleaseNotesVersion = vi.fn(() => null);
const setLastSeenReleaseNotesVersion = vi.fn();
const mergeDiscoveredTools = vi.fn();
const getConfig = vi.fn(() => ({
  whisperUrl: 'http://localhost:8080/inference',
  transcription: {
    activeProvider: 'local-whisper-cpp',
    providers: {
      localWhisperCpp: { endpoint: 'http://localhost:8080/inference' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
      sarvam: { model: 'saaras:v4', mode: 'transcribe' },
      azureSpeech: { endpoint: '', region: '' },
      customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
    },
  },
  selectedDeviceId: null,
  removeFillerWords: true,
  language: 'auto',
  task: 'transcribe',
  dictionary: [],
  pasteStrategy: { default: 'ctrl-v', overrides: {} },
  dictation: { mode: 'batch', formatter: null },
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
  kind: 'win32',
  hwnd: 12345,
  processId: 67890,
  processCreationTime: '2026-01-01T00:00:00.000Z',
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
let trayHandlers: {
  onOpenSettings?: () => void;
  onPasteLastTranscript?: () => void;
  onCopyLastTranscript?: () => void;
  onSelectDevice?: (deviceId: string) => void;
  isShortcutsPaused?: () => boolean;
  onTogglePause?: (paused: boolean) => void;
} = {};
let notificationShow: ReturnType<typeof vi.fn>;
const openSettingsWindow = vi.fn();
const getSettingsWindow = vi.fn(() => ({
  webContents: { send },
  isDestroyed: vi.fn(() => false),
}));

const keyboardStart = vi.fn();
const keyboardStop = vi.fn();
const keyboardWaitForRelease = vi.fn(async () => true);
const agentStartRun = vi.fn();
const agentStart = vi.fn();
const agentStop = vi.fn();
const agentCancelRun = vi.fn();
const agentSendApprovalDecision = vi.fn();
const agentTestMcpServer = vi.fn();
const agentTestProvider = vi.fn();
const agentCancelProviderTest = vi.fn();
const credentialVault = { read: vi.fn(() => null), save: vi.fn(), remove: vi.fn() };
const registerCredentialIpcHandlers = vi.fn();
let agentEventHandler: ((event: any) => void) | null = null;
let agentManagerDeps: {
  onLifecycleError?: (error: { reason: string }) => void;
  onGenerationExit?: () => void;
} | null = null;
const runtimeShellFinish = vi.fn();
const runtimeShellShowFailure = vi.fn();
const runtimeShellShowProcessing = vi.fn();
const runtimeShellSetCrashHandler = vi.fn();
const runtimeShellBeginAgentRun = vi.fn();
const runtimeShellClearAgentRun = vi.fn();
const runtimeShellShowAgentStatus = vi.fn();
const runtimeShellShowAgentStreaming = vi.fn();
const runtimeShellShowAgentApproval = vi.fn();
const runtimeShellShowAgentCompleted = vi.fn();
const runtimeShellShowAgentFailed = vi.fn();
const runtimeShellDismissAgentCard = vi.fn();
const runtimeShellGetPendingApproval = vi.fn((): { serverId: string; toolName: string } | null => null);
const runtimeShellGetPresentedCompletedRunId = vi.fn((): string | null => null);
const runtimeShellHandleAgentCardSize = vi.fn();
const applyDictationFormatter = vi.fn();

// Mock RecordingSession
const recordingSessionStart = vi.fn();
const recordingSessionStop = vi.fn();
const recordingSessionIsBusy = vi.fn(() => false);
const recordingSessionBegin = vi.fn();
const recordingSessionEnd = vi.fn(() => Promise.resolve({ text: 'transcribed text', intent: 'dictation', targetSnapshot: null }));
const recordingSessionCancel = vi.fn(() => Promise.resolve());
const recordingSessionUpdateDevice = vi.fn();
let sessionOptions: any = null;

installElectronMock();
const keyboardSetPaused = vi.fn();
const keyboardIsPaused = vi.fn(() => false);
const keyboardSetCaptureSuspended = vi.fn();
const setSettingsWindowClosedHandler = vi.fn();
const updateShortcutPauseState = vi.fn();

mock.module('../native/keyboard', () => ({
  keyboardHook: {
    start: keyboardStart,
    stop: keyboardStop,
    setPaused: keyboardSetPaused,
    isPaused: keyboardIsPaused,
    setCaptureSuspended: keyboardSetCaptureSuspended,
    waitForKeysReleased: keyboardWaitForRelease,
    waitForShortcutDeactivation: vi.fn(async () => true),
    refreshShortcuts: vi.fn(),
    setLinuxShortcutStatusListener: vi.fn(),
  },
}));
const kdeFocus = { windowId: 'kwin-1', epoch: 3, appId: 'org.kde.kate' };
const kdeTracker = {
  capture: vi.fn(() => kdeFocus),
  validate: vi.fn((snapshot: typeof kdeFocus) => snapshot.windowId === kdeFocus.windowId && snapshot.epoch === kdeFocus.epoch),
  isAlive: () => true,
  close: vi.fn(async () => {}),
};
const remoteKeyboard = {
  setup: vi.fn(async () => {}),
  isReady: vi.fn(() => true),
  paste: vi.fn(async () => ({ acceptedEvents: 4 }) as { acceptedEvents: number; error?: string }),
  close: vi.fn(async () => {}),
};
mock.module('../desktop/kde-focus', () => ({ createKdeFocusTracker: async () => kdeTracker }));
mock.module('../desktop/remote-desktop-keyboard', () => ({ createRemoteDesktopKeyboard: () => remoteKeyboard }));
mock.module('../native/clipboard', () => ({
  simulatePaste,
  getClipboardSequenceNumber,
}));
mock.module('../native/target', () => ({ captureForegroundTarget }));
mock.module('../desktop/dev-identity', () => ({ prepareDevelopmentIdentity: () => () => {} }));
mock.module('../settings-window', () => ({ getSettingsWindow, openSettingsWindow, setSettingsWindowClosedHandler }));
mock.module('../tray', () => ({
  createTray: vi.fn((handlers: typeof trayHandlers) => {
    trayHandlers = handlers;
  }),
  updateAudioDevices,
  updateUpdaterStatus,
  updateShortcutPauseState,
}));
mock.module('../config', () => ({
  getConfig,
  getChatGptHostId: () => 'urn:uuid:installation',
  setChatGptHostId: vi.fn(),
  setConfig,
  patchTranscriptionConfig: vi.fn(),
  mergeDiscoveredTools,
  getLastSeenReleaseNotesVersion,
  setLastSeenReleaseNotesVersion,
}));
mock.module('../credential-vault', () => ({ credentialVault }));
mock.module('../credential-ipc', () => ({ registerCredentialIpcHandlers }));
mock.module('../updater', () => ({ setupUpdater: vi.fn(), checkForUpdates, getUpdateStatus }));
mock.module('../agent-sidecar', () => ({
  AgentSidecarManager: class {
    constructor(onEvent: (event: any) => void, deps?: {
      onLifecycleError?: (error: { reason: string }) => void;
      onGenerationExit?: () => void;
    }) {
      agentEventHandler = onEvent;
      agentManagerDeps = deps ?? null;
    }
    start = agentStart;
    startRun = agentStartRun;
    stop = agentStop;
    cancelRun = agentCancelRun;
    sendApprovalDecision = agentSendApprovalDecision;
    testMcpServer = agentTestMcpServer;
    testProvider = agentTestProvider;
    cancelProviderTest = agentCancelProviderTest;
  },
}));
mock.module('../runtime-shell', () => ({
  RuntimeShell: class {
    finish = runtimeShellFinish;
    showFailure = runtimeShellShowFailure;
    showProcessing = runtimeShellShowProcessing;
    setCrashHandler = runtimeShellSetCrashHandler;
    beginAgentRun = runtimeShellBeginAgentRun;
    clearAgentRun = runtimeShellClearAgentRun;
    showAgentStatus = runtimeShellShowAgentStatus;
    showAgentStreaming = runtimeShellShowAgentStreaming;
    showAgentApproval = runtimeShellShowAgentApproval;
    showAgentCompleted = runtimeShellShowAgentCompleted;
    showAgentFailed = runtimeShellShowAgentFailed;
    dismissAgentCard = runtimeShellDismissAgentCard;
    getPendingApproval = runtimeShellGetPendingApproval;
    getPresentedCompletedRunId = runtimeShellGetPresentedCompletedRunId;
    handleAgentCardSize = runtimeShellHandleAgentCardSize;
  },
}));
mock.module('../dictation-formatter', () => ({ applyDictationFormatter }));
mock.module('../dictation-formatter-credential', () => ({
  getDictationFormatterApiKey: vi.fn(() => null),
}));
mock.module('../recording-session', () => ({
  RecordingSession: class {
    constructor(options: any) {
      const route = options.onResult;
      sessionOptions = {
        ...options,
        onResult: (result: any) => route(result ? {
          dictation: options.getDictationContext(),
          signal: new AbortController().signal,
          outcome: { kind: 'completed' },
          ...result,
        } : null),
      };
    }
    start = recordingSessionStart;
    stop = recordingSessionStop;
    isBusy = recordingSessionIsBusy;
    begin = recordingSessionBegin;
    end = recordingSessionEnd;
    cancel = recordingSessionCancel;
    updateDevice = recordingSessionUpdateDevice;
    markRuntimeShellCrashed = vi.fn();
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
        sarvam: { model: 'saaras:v4', mode: 'transcribe' },
        azureSpeech: { endpoint: '', region: '' },
        customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
      },
    },
    selectedDeviceId: null,
    removeFillerWords: true,
    language: 'auto',
    task: 'transcribe',
    dictionary: [],
    pasteStrategy: { default: 'ctrl-v', overrides: {} },
    setupChecklistDismissed: true,
    onboarding: { status: 'complete' },
    dictation: { mode: 'batch', formatter: null },
    shortcuts: {
      dictation: { binding: { keyCode: null, modifiers: ['ctrl', 'win'] }, activationMode: 'push-to-talk' },
      agent: { binding: { keyCode: null, modifiers: ['alt', 'win'] }, activationMode: 'push-to-talk' },
    },
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
    setPlatform(nativePlatform);
    if (originalSessionType === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = originalSessionType;
    if (originalWaylandDisplay === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = originalWaylandDisplay;
  });

  beforeEach(async () => {
    setPlatform(nativePlatform);
    process.env.XDG_SESSION_TYPE = 'x11';
    delete process.env.WAYLAND_DISPLAY;
    ipcHandlers.clear();
    ipcListeners.clear();
    appListeners.clear();
    powerMonitorListeners.clear();
    trayHandlers = {};
    clipboardText.value = 'original';
    resetElectronMock();
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))) as typeof fetch;
    notificationShow = vi.fn();
    electronMock.Notification.mockImplementation(() => ({ show: notificationShow }));
    electronMock.app.on.mockImplementation((event: string, listener: (...args: any[]) => void) => {
      appListeners.set(event, listener);
    });
    electronMock.powerMonitor.on.mockImplementation((event: string, listener: (...args: any[]) => void) => {
      powerMonitorListeners.set(event, listener);
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
    recordingSessionCancel.mockClear();
    setConfig.mockClear();
    getLastSeenReleaseNotesVersion.mockClear();
    setLastSeenReleaseNotesVersion.mockClear();
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
    keyboardWaitForRelease.mockReset();
    keyboardWaitForRelease.mockResolvedValue(true);
    keyboardSetPaused.mockClear();
    keyboardIsPaused.mockClear();
    keyboardIsPaused.mockReturnValue(false);
    keyboardSetCaptureSuspended.mockClear();
    setSettingsWindowClosedHandler.mockClear();
    updateShortcutPauseState.mockClear();
    agentStartRun.mockClear();
    agentStart.mockClear();
    agentStop.mockClear();
    agentCancelRun.mockClear();
    agentSendApprovalDecision.mockClear();
    agentTestMcpServer.mockClear();
    agentTestProvider.mockReset();
    agentCancelProviderTest.mockClear();
    credentialVault.read.mockReset();
    credentialVault.read.mockReturnValue(null);
    agentEventHandler = null;
    agentManagerDeps = null;
    runtimeShellFinish.mockClear();
    runtimeShellShowFailure.mockClear();
    runtimeShellShowProcessing.mockClear();
    runtimeShellSetCrashHandler.mockClear();
    runtimeShellBeginAgentRun.mockClear();
    runtimeShellClearAgentRun.mockClear();
    runtimeShellShowAgentStatus.mockClear();
    runtimeShellShowAgentStreaming.mockClear();
    runtimeShellShowAgentApproval.mockClear();
    runtimeShellShowAgentCompleted.mockClear();
    runtimeShellShowAgentFailed.mockClear();
    runtimeShellDismissAgentCard.mockClear();
    runtimeShellHandleAgentCardSize.mockClear();
    applyDictationFormatter.mockReset();
    applyDictationFormatter.mockResolvedValue({ kind: 'success', text: 'formatted text' });
    getConfig.mockReturnValue(baseConfig);

    recordingSessionStart.mockClear();
    recordingSessionIsBusy.mockReturnValue(false);
    recordingSessionStop.mockClear();
    recordingSessionBegin.mockClear();
    recordingSessionEnd.mockClear();
    recordingSessionUpdateDevice.mockClear();
    sessionOptions = null;

    await import(`../index?test=${Date.now()}-${Math.random()}`);
  });

  it('validates provider settings locally while disabled and never launches a sidecar test', async () => {
    const provider = { baseUrl: 'http://[::1]:11434/v1', model: 'local', apiKeyEnvVar: '', auth: 'none' };
    const validation = await ipcHandlers.get('agent:validate-provider')?.({}, provider);
    expect(validation).toEqual({ issues: [], credentials: 'not-required' });
    const result = await ipcHandlers.get('agent:test-provider')?.({}, provider);
    expect(result).toMatchObject({ diagnostic: { kind: 'configuration', message: 'Agent Mode is disabled.' } });
    expect(agentTestProvider).not.toHaveBeenCalled();
    expect(agentStart).not.toHaveBeenCalled();
  });

  it('blocks known LLM credential errors only for Agent recording', () => {
    getConfig.mockReturnValue({ ...baseConfig, agent: { ...baseConfig.agent, enabled: true, provider: {
      baseUrl: 'https://resource.openai.azure.com/openai/v1', model: 'production', apiKeyEnvVar: '', apiKeySource: 'stored', auth: 'api-key',
    } } });
    expect(sessionOptions.getReadinessError('agent')?.message).toContain('saved API key is unavailable');
    expect(sessionOptions.getReadinessError('dictation')).toBeNull();
  });

  it('forwards a saved key to the sidecar probe without returning it to Settings', async () => {
    const provider = { baseUrl: 'https://resource.openai.azure.com/openai/v1', model: 'production', apiKeyEnvVar: '', apiKeySource: 'stored', auth: 'api-key' };
    getConfig.mockReturnValue({ ...baseConfig, agent: { ...baseConfig.agent, enabled: true } });
    credentialVault.read.mockReturnValue('saved-agent-secret');
    agentTestProvider.mockResolvedValue({ diagnostic: { kind: 'authentication', message: 'Rejected' } });
    const result = await ipcHandlers.get('agent:test-provider')?.({}, provider);
    expect(agentTestProvider).toHaveBeenCalledWith(expect.objectContaining({ model: 'production', auth: 'api-key' }), 'saved-agent-secret');
    expect(JSON.stringify(result)).not.toContain('saved-agent-secret');
    const changed = registerCredentialIpcHandlers.mock.calls.at(-1)?.[2];
    changed('agent-api-key');
    expect(agentCancelProviderTest).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('agent:provider-invalidated');
  });

  it('uses the plan grant for runs and probes while exposing only account status to Settings', async () => {
    const provider = { ...baseConfig.agent.provider, kind: 'chatgpt', model: 'gpt-plan', apiKeySource: 'stored' };
    const config = { ...baseConfig, agent: { ...baseConfig.agent, enabled: true, provider } };
    getConfig.mockReturnValue(config);
    credentialVault.read.mockImplementation((id: string) => id === 'chatgpt-account' ? JSON.stringify({
      clientId: 'issued-client', issuer: 'https://auth.openai.com', subject: 'account', email: 'user@example.com',
      tokens: { accessToken: 'private-plan-token', refreshToken: 'private-refresh', idToken: 'private-identity',
        expiresAt: Date.now() + 3600_000, scopes: ['chatgpt.tokens.use.direct'] },
    }) : 'paid-api-key');
    await import(`../index?test=${Date.now()}-chatgpt-grant`);
    agentTestProvider.mockResolvedValue({ streaming: { status: 'passed' } });
    expect(await ipcHandlers.get('chatgpt:get-status')?.({})).toEqual({ state: 'signed-in', email: 'user@example.com', planUsage: true });
    expect(await ipcHandlers.get('agent:validate-provider')?.({}, provider)).toEqual({ credentials: 'available', issues: [] });
    const result = await ipcHandlers.get('agent:test-provider')?.({}, provider);
    expect(agentTestProvider).toHaveBeenCalledWith(expect.objectContaining({ kind: 'chatgpt' }), 'private-plan-token');
    expect(JSON.stringify(result)).not.toContain('private-');
    await sessionOptions.onResult({ text: 'Do the task.', intent: 'agent', targetSnapshot: defaultTargetSnapshot });
    expect(agentStartRun).toHaveBeenCalledWith(expect.any(String), 'Do the task.', config, 'private-plan-token', expect.any(Object), undefined);
    expect(JSON.stringify(send.mock.calls)).not.toContain('private-');
    expect(simulatePaste).not.toHaveBeenCalled();
  });

  it('does not start a cancelled provider probe after a pending token refresh finishes', async () => {
    const provider = { ...baseConfig.agent.provider, kind: 'chatgpt', model: 'gpt-plan' };
    getConfig.mockReturnValue({ ...baseConfig, agent: { ...baseConfig.agent, enabled: true, provider } });
    credentialVault.read.mockReturnValue(JSON.stringify({
      clientId: 'issued-client', issuer: 'https://auth.openai.com', subject: 'account', email: 'user@example.com',
      tokens: { accessToken: 'old-token', refreshToken: 'old-refresh', idToken: 'identity', expiresAt: 0, scopes: ['chatgpt.tokens.use.direct'] },
    }));
    await import(`../index?test=${Date.now()}-chatgpt-probe-cancel`);
    let finishRefresh!: (response: Response) => void;
    let refreshed!: () => void;
    const started = new Promise<void>(resolve => { refreshed = resolve; });
    globalThis.fetch = vi.fn(() => new Promise<Response>(resolve => { finishRefresh = resolve; refreshed(); }));
    const pending = ipcHandlers.get('agent:test-provider')?.({}, provider);
    await started;
    await ipcHandlers.get('agent:cancel-provider-test')?.({});
    finishRefresh(Response.json({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' }));
    expect(await pending).toMatchObject({ diagnostic: { kind: 'cancelled' } });
    expect(agentTestProvider).not.toHaveBeenCalled();
  });

  it('pauses shortcuts through IPC and restores capture suspension explicitly', async () => {
    keyboardIsPaused.mockReturnValueOnce(false).mockReturnValueOnce(true);

    expect(await ipcHandlers.get('shortcuts:get-paused')?.({})).toBe(false);
    expect(await ipcHandlers.get('shortcuts:set-paused')?.({}, true)).toBe(true);
    expect(keyboardSetPaused).toHaveBeenCalledWith(true);
    expect(updateShortcutPauseState).toHaveBeenCalledWith(true);
    expect(send).toHaveBeenCalledWith('shortcuts:paused-changed', true);

    ipcHandlers.get('shortcuts:begin-capture')?.({});
    ipcHandlers.get('shortcuts:end-capture')?.({});
    expect(keyboardSetCaptureSuspended.mock.calls).toEqual([[true], [false]]);
  });

  it('shows transcription failures through a sanitized runtime shell failure card', () => {
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      sessionOptions.onError(new Error('token=super-secret'));
      expect(runtimeShellShowFailure).toHaveBeenCalledWith(
        null,
        'Transcription failed unexpectedly. Check provider settings and try again.',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('super-secret');
      expect(electronMock.dialog.showErrorBox).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it('checks the configured local endpoint without audio', async () => {
    await expect(ipcHandlers.get('transcription:check-server')?.({})).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith('http://localhost:8080/inference', { method: 'HEAD' });
  });

  it('returns a typed readiness result for non-WhisperLiveKit providers without probing the network', async () => {
    await expect(ipcHandlers.get('transcription:check-readiness')?.({})).resolves.toMatchObject({
      providerId: 'local-whisper-cpp',
      state: 'ready',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('publishes checking and terminal readiness for an explicitly selected WhisperLiveKit provider', async () => {
    const config = {
      ...baseConfig,
      transcription: {
        ...baseConfig.transcription,
        activeProvider: 'whisper-live-kit' as const,
        providers: {
          ...baseConfig.transcription.providers,
          whisperLiveKit: { baseUrl: 'http://127.0.0.1:8000', auth: 'none' as const },
        },
      },
    };
    getConfig.mockReturnValue(config);

    const readiness = await ipcHandlers.get('transcription:check-readiness')?.({});

    expect(readiness).toMatchObject({
      providerId: 'whisper-live-kit',
      state: 'unavailable',
    });
    expect(send).toHaveBeenCalledWith('transcription:readiness-changed', expect.objectContaining({
      state: 'checking',
    }));
    expect(send).toHaveBeenCalledWith('transcription:readiness-changed', expect.objectContaining({
      state: 'unavailable',
    }));
  });

  it('transcribes completed audio and restores the clipboard after paste', async () => {
    // Simulate successful result callback
    const result = {
      text: 'transcribed text',
      intent: 'dictation' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);

    expect(simulatePaste).toHaveBeenCalled();
    expect(electronMock.clipboard.writeText).toHaveBeenNthCalledWith(1, 'transcribed text');
    expect(electronMock.clipboard.write).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'original' }));
  });

  it('completes onboarding only after a real Dictation is inserted', async () => {
    getConfig.mockReturnValue({ ...baseConfig, onboarding: { status: 'pending' } });

    await sessionOptions.onResult({
      text: 'onboarding dictation',
      intent: 'dictation',
      targetSnapshot: defaultTargetSnapshot,
    });

    expect(setConfig).toHaveBeenCalledWith('onboarding', { status: 'complete' });
    expect(setConfig).toHaveBeenCalledWith('setupChecklistDismissed', true);
    expect(send).toHaveBeenCalledWith('onboarding:completed');
  });

  it('routes agent recordings to the sidecar without injecting text', async () => {
    const config = {
      ...baseConfig,
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

    expect(agentStartRun).toHaveBeenCalledWith(expect.any(String), 'transcribed text', config, undefined,
      { memory: null, skillsDirectory: expect.stringContaining('skills') }, undefined);
    expect(simulatePaste).not.toHaveBeenCalled();
    // A lingering "Transcribing…" pill outranks and hides every Agent card for the whole run.
    expect(runtimeShellFinish).toHaveBeenCalled();
  });

  it('routes a WhisperLiveKit Batch transcript to Agent Mode without changing the provider path', async () => {
    const config = {
      ...baseConfig,
      transcription: {
        ...baseConfig.transcription,
        activeProvider: 'whisper-live-kit' as const,
        providers: {
          ...baseConfig.transcription.providers,
          whisperLiveKit: { baseUrl: 'http://127.0.0.1:8000', auth: 'none' as const },
        },
      },
      agent: {
        ...baseConfig.agent,
        enabled: true,
      },
    };
    getConfig.mockReturnValue(config);
    await import(`../index?test=${Date.now()}-whisper-live-kit-agent`);

    await sessionOptions.onResult({
      text: 'Quick brown fox jumps over the lazy dog.',
      intent: 'agent' as const,
      targetSnapshot: defaultTargetSnapshot,
    });

    expect(agentStartRun).toHaveBeenCalledWith(
      expect.any(String),
      'Quick brown fox jumps over the lazy dog.',
      config,
      undefined,
      { memory: null, skillsDirectory: expect.stringContaining('skills') },
      undefined,
    );
    expect(simulatePaste).not.toHaveBeenCalled();
  });

  it('routes dictation recordings through clipboard injection and not the agent sidecar', async () => {
    const result = {
      text: 'transcribed text',
      intent: 'dictation' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);

    expect(agentStartRun).not.toHaveBeenCalled();
    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith('transcribed text');
  });

  it('keeps the transcript copyable without changing the clipboard or sending input on Wayland', async () => {
    setPlatform('linux');
    process.env.XDG_SESSION_TYPE = 'wayland';
    await sessionOptions.onResult({
      text: 'safe transcript', intent: 'dictation', recordingSessionId: 'wayland',
      targetSnapshot: null,
    });
    expect(simulatePaste).not.toHaveBeenCalled();
    expect(electronMock.clipboard.writeText).not.toHaveBeenCalled();
    expect(runtimeShellShowFailure).toHaveBeenCalledWith('wayland',
      expect.stringContaining('original input context cannot be verified'), ['copy-full-transcript']);
    await trayHandlers.onCopyLastTranscript?.();
    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith('safe transcript');
  });

  it('reports the Wayland policy error when pasting the last transcript from the tray', async () => {
    setPlatform('linux');
    process.env.XDG_SESSION_TYPE = 'wayland';
    await sessionOptions.onResult({ text: 'saved transcript', intent: 'dictation', targetSnapshot: null });
    captureForegroundTarget.mockReturnValue(null);
    await trayHandlers.onPasteLastTranscript?.();
    expect(electronMock.Notification).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'Paste last transcript failed',
      body: expect.stringContaining('original input context cannot be verified'),
    }));
    expect(simulatePaste).not.toHaveBeenCalled();
  });

  describe('KDE Wayland best-effort test mode', () => {
    const originalDesktop = process.env.XDG_CURRENT_DESKTOP;
    beforeEach(async () => {
      setPlatform('linux');
      process.env.XDG_SESSION_TYPE = 'wayland';
      process.env.XDG_CURRENT_DESKTOP = 'KDE';
      captureForegroundTarget.mockReturnValue(null); // the real capture has no Wayland target
      remoteKeyboard.setup.mockReset();
      remoteKeyboard.setup.mockResolvedValue(undefined);
      remoteKeyboard.paste.mockClear();
      await import(`../index?test=${Date.now()}-kde-wayland`);
    });
    afterAll(() => {
      if (originalDesktop === undefined) delete process.env.XDG_CURRENT_DESKTOP;
      else process.env.XDG_CURRENT_DESKTOP = originalDesktop;
    });

    it('stays copy-only until setup runs, then pastes once into the window pinned at record start', async () => {
      expect(sessionOptions.captureTarget()).toBeNull();
      const status = await ipcHandlers.get('desktop:set-wayland-insertion')!({}, true) as import('../../shared/desktop-status').DesktopStatus;
      expect(setConfig).toHaveBeenCalledWith('waylandBestEffortInsertion', true);
      expect(status.delivery.available).toBe(true);
      expect(status.waylandInsertion?.state).toBe('ready');

      const targetSnapshot = sessionOptions.captureTarget();
      expect(targetSnapshot).toMatchObject({ kind: 'kde-wayland', windowId: 'kwin-1', epoch: 3 });
      await sessionOptions.onResult({
        text: 'kde words', intent: 'dictation', recordingSessionId: 'kde', targetSnapshot,
        signal: new AbortController().signal, outcome: { kind: 'completed' },
        dictation: { config: { mode: 'batch', formatter: null }, language: 'auto', protectedTerms: [], formatterApiKey: null },
      });

      expect(electronMock.clipboard.writeText).toHaveBeenCalledWith('kde words');
      expect(remoteKeyboard.paste).toHaveBeenCalledTimes(1);
      expect(simulatePaste).not.toHaveBeenCalled();
      expect(runtimeShellShowFailure).not.toHaveBeenCalled();

      recordingSessionIsBusy.mockReturnValue(true);
      runtimeShellFinish.mockClear();
      remoteKeyboard.paste.mockClear();
      await trayHandlers.onPasteLastTranscript?.();
      expect(remoteKeyboard.paste).toHaveBeenCalledTimes(1);
      expect(runtimeShellFinish).not.toHaveBeenCalled();
    });

    it('keeps Wayland blocked and the setting off when keyboard control is declined', async () => {
      remoteKeyboard.setup.mockRejectedValue(new Error('Request cancelled.'));
      const status = await ipcHandlers.get('desktop:set-wayland-insertion')!({}, true) as import('../../shared/desktop-status').DesktopStatus;

      expect(setConfig).toHaveBeenCalledWith('waylandBestEffortInsertion', false);
      expect(status.delivery.available).toBe(false);
      expect(status.waylandInsertion).toMatchObject({ state: 'unavailable', message: expect.stringContaining('Keyboard control was not granted') });
      expect(sessionOptions.captureTarget()).toBeNull();
    });
  });

  it('does not turn an unknown original destination into the window focused at completion', async () => {
    await sessionOptions.onResult({
      text: 'keep this text', intent: 'dictation', recordingSessionId: 'unknown-destination', targetSnapshot: null,
    });
    expect(simulatePaste).not.toHaveBeenCalled();
    expect(electronMock.clipboard.writeText).not.toHaveBeenCalled();
    expect(runtimeShellShowFailure).toHaveBeenCalledWith('unknown-destination',
      expect.stringContaining('original destination could not be identified'), ['copy-full-transcript']);
  });

  it('offers explicit recovery without pasting if the recording chord remains held', async () => {
    keyboardWaitForRelease.mockResolvedValueOnce(false);
    await sessionOptions.onResult({
      text: 'waiting words', intent: 'dictation', recordingSessionId: 'held-chord',
      targetSnapshot: defaultTargetSnapshot,
    });
    expect(simulatePaste).not.toHaveBeenCalled();
    expect(electronMock.clipboard.writeText).not.toHaveBeenCalled();
    expect(runtimeShellShowFailure).toHaveBeenCalledWith('held-chord',
      expect.stringContaining('Release the recording shortcut'), ['retry-paste', 'copy-full-transcript']);
  });

  it('does not insert a formatter result after its recording was cancelled', async () => {
    const controller = new AbortController();
    let finish!: (outcome: { kind: 'success'; text: string }) => void;
    let started!: () => void;
    const formatting = new Promise<void>(resolve => { started = resolve; });
    applyDictationFormatter.mockImplementation(() => {
      started();
      return new Promise(resolve => { finish = resolve; });
    });
    const routing = sessionOptions.onResult({
      text: 'raw words', intent: 'dictation', recordingSessionId: 'cancelled-formatter',
      targetSnapshot: defaultTargetSnapshot, signal: controller.signal,
      dictation: {
        config: { mode: 'corrected', formatter: { baseUrl: 'http://localhost:11434/v1',
          model: 'original-model', apiKeyEnvVar: '', apiKeySource: 'environment', processingConsent: true } },
        language: 'mr', protectedTerms: ['Shuddhalekhan'], formatterApiKey: 'original-secret',
      },
    });
    await formatting;
    expect(applyDictationFormatter).toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({ model: 'original-model' }),
      language: 'mr', protectedTerms: ['Shuddhalekhan'], apiKey: 'original-secret', signal: controller.signal,
    }));
    controller.abort();
    finish({ kind: 'success', text: 'late words' });
    await routing;
    expect(simulatePaste).not.toHaveBeenCalled();
    expect(electronMock.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('keeps partial recognition copy-only and never inserts it after final recognition fails', async () => {
    await import(`../index?test=${Date.now()}-recognized-so-far`);

    await sessionOptions.onResult({
      text: 'recognized so far',
      intent: 'dictation' as const,
      targetSnapshot: defaultTargetSnapshot,
      recordingSessionId: 'recognized-so-far',
      outcome: { kind: 'failed' as const, message: 'Batch fallback failed' },
    });

    expect(runtimeShellShowFailure).toHaveBeenCalledWith(
      'recognized-so-far',
      'Transcription could not complete. Last Transcript contains the text recognized so far.',
      ['copy-full-transcript'],
    );
    expect(simulatePaste).not.toHaveBeenCalled();

    await trayHandlers.onCopyLastTranscript?.();
    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith('recognized so far');
  });

  it('hides the recovery shell before Retry Paste validates the target', async () => {
    ipcListeners.clear();
    captureForegroundTarget.mockReturnValueOnce({
      ...defaultTargetSnapshot,
      processId: defaultTargetSnapshot.processId + 1,
    });
    await import(`../index?test=${Date.now()}-runtime-retry`);

    await sessionOptions.onResult({
      text: 'transcribed text',
      intent: 'dictation' as const,
      targetSnapshot: defaultTargetSnapshot,
      recordingSessionId: 'session-1',
    });
    expect(runtimeShellShowFailure).toHaveBeenCalledTimes(1);

    runtimeShellFinish.mockClear();

    let markPasteStarted: () => void = () => undefined;
    const pasteStarted = new Promise<void>((resolve) => { markPasteStarted = resolve; });
    captureForegroundTarget.mockImplementation(() => {
      expect(runtimeShellFinish).toHaveBeenCalledTimes(1);
      return defaultTargetSnapshot;
    });
    simulatePaste.mockImplementation(() => {
      markPasteStarted();
      return { acceptedEvents: 4 };
    });

    ipcListeners.get('runtime:recovery-action')?.({}, 'retry-paste');
    await pasteStarted;

    expect(runtimeShellFinish).toHaveBeenCalledTimes(1);
  });

  it('ignores duplicate retry-paste recovery actions while injection is in flight', async () => {
    ipcListeners.clear();
    captureForegroundTarget.mockReturnValueOnce({
      ...defaultTargetSnapshot,
      processId: defaultTargetSnapshot.processId + 1,
    });
    await import(`../index?test=${Date.now()}-runtime-retry-dedupe`);

    await sessionOptions.onResult({
      text: 'transcribed text',
      intent: 'dictation' as const,
      targetSnapshot: defaultTargetSnapshot,
      recordingSessionId: 'session-1',
    });
    expect(runtimeShellShowFailure).toHaveBeenCalledTimes(1);

    runtimeShellFinish.mockClear();
    let releasePaste: () => void = () => undefined;
    const pasteGate = new Promise<void>((resolve) => { releasePaste = resolve; });
    let markPasteStarted: () => void = () => undefined;
    const pasteStarted = new Promise<void>((resolve) => { markPasteStarted = resolve; });
    captureForegroundTarget.mockReturnValue(defaultTargetSnapshot);
    simulatePaste.mockImplementation(async () => {
      markPasteStarted();
      await pasteGate;
      return { acceptedEvents: 4 };
    });

    const handler = ipcListeners.get('runtime:recovery-action');
    handler?.({}, 'retry-paste');
    handler?.({}, 'retry-paste');
    releasePaste();
    await pasteStarted;

    expect(runtimeShellFinish).toHaveBeenCalledTimes(1);
    expect(simulatePaste).toHaveBeenCalledTimes(1);
  });

  it('shows an agent status message instead of starting the sidecar when Agent Mode is disabled', async () => {
    const result = {
      text: 'transcribed text',
      intent: 'agent' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);

    expect(agentStartRun).not.toHaveBeenCalled();
    expect(runtimeShellShowAgentStatus).toHaveBeenCalledWith(
      null,
      'Agent Mode is disabled. Open Settings to enable it.',
    );
  });

  it('projects approval requests onto the shared agent shell when it is enabled', async () => {
    const config = { ...baseConfig, agent: { ...baseConfig.agent, enabled: true } };
    getConfig.mockReturnValue(config);

    await import(`../index?test=${Date.now()}-shell-approval`);

    const result = {
      text: 'transcribed text',
      intent: 'agent' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);
    const activeRunId = agentStartRun.mock.calls[0]?.[0] as string;

    expect(runtimeShellClearAgentRun).toHaveBeenCalledTimes(1);

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

    expect(runtimeShellShowAgentApproval).toHaveBeenCalledWith(expect.objectContaining({
      agentRunId: activeRunId,
      approvalId: 'approval-1',
    }));
  });

  it('cancels the active run when a new Agent recording starts and drops its late events', async () => {
    const config = { ...baseConfig, agent: { ...baseConfig.agent, enabled: true } };
    getConfig.mockReturnValue(config);

    await import(`../index?test=${Date.now()}-agent-recording-invalidates-run`);
    await sessionOptions.onResult({
      text: 'first command',
      intent: 'agent' as const,
      targetSnapshot: defaultTargetSnapshot,
    });
    const previousRunId = agentStartRun.mock.calls[0]?.[0] as string;
    runtimeShellShowAgentStatus.mockClear();

    sessionOptions.onBegin('agent');
    agentEventHandler?.({
      type: 'agent:status',
      agentRunId: previousRunId,
      status: 'Late status',
    });

    expect(agentCancelRun).toHaveBeenCalledWith(previousRunId);
    expect(runtimeShellShowAgentStatus).not.toHaveBeenCalled();
  });

  it('continues the conversation only when an Agent recording begins over a completed answer', async () => {
    const config = { ...baseConfig, agent: { ...baseConfig.agent, enabled: true } };
    getConfig.mockReturnValue(config);
    await import(`../index?test=${Date.now()}-agent-reply`);
    const command = (text: string) => sessionOptions.onResult({ text, intent: 'agent' as const, targetSnapshot: defaultTargetSnapshot });

    runtimeShellGetPresentedCompletedRunId.mockReturnValueOnce('answered-run');
    sessionOptions.onBegin('agent');
    await command('Pune.');
    sessionOptions.onBegin('agent');
    await command('Tell me a joke.');

    expect(agentStartRun.mock.calls.map((call: unknown[]) => call.at(-1))).toEqual(['answered-run', undefined]);
  });

  it('shows one persistent shell failure when the sidecar exits unexpectedly', async () => {

    await import(`../index?test=${Date.now()}-shell-gen-exit`);

    agentManagerDeps?.onGenerationExit?.();

    expect(runtimeShellShowAgentFailed).toHaveBeenCalledTimes(1);
    expect(runtimeShellShowAgentFailed).toHaveBeenCalledWith(null, 'Agent runtime stopped unexpectedly. Try Agent Mode again.');
  });

  it('dismisses a presented agent terminal card through the runtime IPC channel', async () => {
    const config = { ...baseConfig, agent: { ...baseConfig.agent, enabled: true } };
    getConfig.mockReturnValue(config);

    await import(`../index?test=${Date.now()}-shell-dismiss`);

    const result = {
      text: 'transcribed text',
      intent: 'agent' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);
    const activeRunId = agentStartRun.mock.calls[0]?.[0] as string;

    agentEventHandler?.({
      type: 'agent:completed',
      agentRunId: activeRunId,
      response: 'Finished',
      toolSummary: [],
    });
    expect(runtimeShellShowAgentCompleted).toHaveBeenCalledTimes(1);

    ipcListeners.get('runtime:agent-dismiss')?.({});

    expect(runtimeShellDismissAgentCard).toHaveBeenCalledTimes(1);
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
    ipcHandlers.get('agent:approval-decision')?.({}, 'run-1', 'approval-1', 'denied', 'no');
    ipcHandlers.get('audio:select-device')?.({}, 'mic-1');
    ipcHandlers.get('updater:check')?.({});
    ipcListeners.get('audio-devices')?.({}, [{ deviceId: 'mic-1', label: 'Mic', kind: 'audioinput' }]);

    expect(setConfig).toHaveBeenCalledWith('whisperUrl', 'http://new');
    expect(agentStart).not.toHaveBeenCalled();
    expect(agentStop).not.toHaveBeenCalled();
    expect(agentTestMcpServer).not.toHaveBeenCalled();
    expect(agentSendApprovalDecision).toHaveBeenCalledWith('run-1', 'approval-1', 'denied', 'no');
    expect(setConfig).toHaveBeenCalledWith('selectedDeviceId', 'mic-1');
    expect(recordingSessionUpdateDevice).toHaveBeenCalledWith('mic-1');
    expect(checkForUpdates).toHaveBeenCalled();
    expect(updateAudioDevices).toHaveBeenCalledWith([{ deviceId: 'mic-1', label: 'Mic', kind: 'audioinput' }]);
  });

  it('updates Agent Mode hotkey enablement without reading config per keypress', async () => {
    getConfig.mockClear();
    expect(sessionOptions.isAgentModeEnabled()).toBe(false);
    expect(getConfig).not.toHaveBeenCalled();

    const enabledConfig = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        enabled: true,
      },
    };

    getConfig.mockReturnValueOnce(baseConfig).mockReturnValueOnce(enabledConfig);
    await ipcHandlers.get('config:set')?.({}, 'agent', enabledConfig.agent);
    expect(agentStart).toHaveBeenCalledWith(enabledConfig, undefined);
    getConfig.mockClear();
    expect(sessionOptions.isAgentModeEnabled()).toBe(true);
    expect(getConfig).not.toHaveBeenCalled();

    getConfig.mockReturnValueOnce(enabledConfig).mockReturnValueOnce(baseConfig);
    await ipcHandlers.get('config:set')?.({}, 'agent', baseConfig.agent);
    expect(agentStop).toHaveBeenCalled();
    getConfig.mockClear();
    expect(sessionOptions.isAgentModeEnabled()).toBe(false);
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('tests an MCP server through a targeted sidecar reconnect', async () => {
    const config = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        enabled: true,
        mcpServers: [{
          id: 'mail',
          displayName: 'Mail',
          enabled: true,
          transport: { type: 'http', url: 'https://mail.example.com/mcp', redirect: 'error' },
          discoveredTools: [],
          toolPolicies: {},
        }],
      },
    };
    getConfig.mockReturnValue(config);

    await ipcHandlers.get('mcp:test-server')?.({}, 'mail');

    expect(agentTestMcpServer).toHaveBeenCalledWith(config, undefined, 'mail');
    expect(agentStop).not.toHaveBeenCalled();
    expect(agentStart).not.toHaveBeenCalled();

    getConfig.mockReturnValue({ ...config, agent: { ...config.agent, enabled: false } });
    await ipcHandlers.get('mcp:test-server')?.({}, 'mail');
    getConfig.mockReturnValue({ ...config, agent: {
      ...config.agent,
      mcpServers: [{ ...config.agent.mcpServers[0], enabled: false }],
    } });
    await ipcHandlers.get('mcp:test-server')?.({}, 'mail');
    expect(agentTestMcpServer).toHaveBeenCalledTimes(1);
  });

  it('saves an alwaysAllow policy for the presented tool before approving it', async () => {
    const config = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        enabled: true,
        mcpServers: [{
          id: 'mail',
          displayName: 'Mail',
          enabled: true,
          transport: { type: 'http', url: 'https://mail.example.com/mcp', redirect: 'error' },
          discoveredTools: [{ name: 'send_message', description: '' }],
          toolPolicies: { 'mail:send_message': 'alwaysAsk' },
        }],
      },
    };
    getConfig.mockReturnValue(config);
    runtimeShellGetPendingApproval.mockImplementation((id: string) =>
      id === 'approval-1' ? { serverId: 'mail', toolName: 'send_message' } : null);

    await ipcHandlers.get('agent:approval-decision')?.({}, 'run-1', 'approval-1', 'always-allow');

    expect(setConfig).toHaveBeenCalledWith('agent', expect.objectContaining({
      mcpServers: [expect.objectContaining({ toolPolicies: { 'mail:send_message': 'alwaysAllow' } })],
    }));
    expect(agentStart).toHaveBeenCalledTimes(1);
    expect(agentSendApprovalDecision).toHaveBeenCalledWith('run-1', 'approval-1', 'approved', undefined);

    // A stale approval id approves without touching policy.
    setConfig.mockClear();
    await ipcHandlers.get('agent:approval-decision')?.({}, 'run-1', 'approval-old', 'always-allow');
    expect(setConfig).not.toHaveBeenCalled();
    expect(agentSendApprovalDecision).toHaveBeenLastCalledWith('run-1', 'approval-old', 'approved', undefined);
    runtimeShellGetPendingApproval.mockReset();
    runtimeShellGetPendingApproval.mockImplementation(() => null);
  });

  it('rejects unrecognized approval decisions instead of approving', async () => {
    agentSendApprovalDecision.mockClear();

    expect(() => ipcHandlers.get('agent:approval-decision')?.({}, 'run-1', 'approval-1', 'yes')).toThrow('Invalid approval decision');
    expect(agentSendApprovalDecision).not.toHaveBeenCalled();
  });

  it('waits for sidecar shutdown before allowing quit', async () => {
    let finishStop: () => void = () => undefined;
    agentStop.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishStop = resolve;
    }));
    const preventDefault = vi.fn();

    appListeners.get('before-quit')?.({ preventDefault });

    expect(recordingSessionStop).toHaveBeenCalledTimes(1);
    expect(agentStop).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(electronMock.app.quit).not.toHaveBeenCalled();

    finishStop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(electronMock.app.quit).toHaveBeenCalledTimes(1);
  });

  it('shows a persistent failure card when sidecar containment fails', () => {
    agentManagerDeps?.onLifecycleError?.({ reason: 'job-assignment-failed' });

    expect(runtimeShellShowAgentFailed).toHaveBeenCalledWith(
      null,
      'Agent runtime could not start securely. Check the logs and try again.',
    );
  });

  it('fails active recording closed on screen lock and suspend', async () => {
    await import(`../index?test=${Date.now()}-power-events`);
    await new Promise((resolve) => setTimeout(resolve, 10));

    powerMonitorListeners.get('lock-screen')?.();
    powerMonitorListeners.get('suspend')?.();

    expect(recordingSessionCancel).toHaveBeenCalledTimes(2);
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

    expect(agentStart).toHaveBeenCalledWith(config, undefined);
  });

  it('forwards a persisted stored credential when starting Agent Mode', async () => {
    const config = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        enabled: true,
        provider: {
          ...baseConfig.agent.provider,
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
          apiKeySource: 'stored' as const,
        },
      },
    };
    getConfig.mockReturnValue(config);
    credentialVault.read.mockReturnValue('stored-agent-secret');

    await import(`../index?test=${Date.now()}-agent-startup-stored-key`);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(agentStart).toHaveBeenCalledWith(config, 'stored-agent-secret');
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

  it('refuses model deletion while capture or final transcription still owns a recording', () => {
    recordingSessionIsBusy.mockReturnValue(true);
    expect(() => ipcHandlers.get('managed-local:delete-model')?.({}, { model: 'parakeet', backend: 'cpu' }))
      .toThrow('Finish the current recording before deleting local model files.');
  });

  it('preloads Managed Local after the runtime becomes operational', async () => {
    const { managedLocalTranscriber } = await import('../managed-local');
    const warmup = vi.spyOn(managedLocalTranscriber, 'warmup').mockResolvedValue();
    try {
      getConfig.mockReturnValue({
        ...baseConfig,
        transcription: { ...baseConfig.transcription, activeProvider: 'managed-local' },
      });
      await import(`../index?test=${Date.now()}-managed-local-startup`);
      await Promise.resolve();
      expect(warmup).not.toHaveBeenCalled();

      ipcListeners.get('surface-paint-proxy')?.({}, 'recording');
      await Promise.resolve();
      expect(warmup).toHaveBeenCalledTimes(1);
    } finally {
      warmup.mockRestore();
    }
  });

  it('stores the last transcript before injection so it survives paste failures', async () => {
    simulatePaste.mockReturnValue({ acceptedEvents: 0, errorCode: 5 });

    const result = {
      text: 'transcribed text',
      intent: 'dictation' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);

    expect(electronMock.dialog.showErrorBox).not.toHaveBeenCalled();
    expect(runtimeShellShowFailure).toHaveBeenCalledTimes(1);

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

    simulatePaste.mockClear();
    await trayHandlers.onCopyLastTranscript?.();

    expect(electronMock.clipboard.writeText).toHaveBeenLastCalledWith('transcribed text');
    expect(simulatePaste).not.toHaveBeenCalled();
  });

  it('pastes the last transcript from the tray without clearing an active recording', async () => {
    await sessionOptions.onResult({ text: 'previous words', intent: 'dictation', targetSnapshot: defaultTargetSnapshot });
    recordingSessionIsBusy.mockReturnValue(true);
    runtimeShellFinish.mockClear();
    simulatePaste.mockClear();

    await trayHandlers.onPasteLastTranscript?.();

    expect(simulatePaste).toHaveBeenCalledTimes(1);
    expect(runtimeShellFinish).not.toHaveBeenCalled();
    expect(recordingSessionCancel).not.toHaveBeenCalled();
  });

  it('notifies when tray paste-last-transcript fails again', async () => {
    const result = {
      text: 'transcribed text',
      intent: 'dictation' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);

    notificationShow.mockClear();
    simulatePaste.mockReturnValue({ acceptedEvents: 0, errorCode: 5 });
    await trayHandlers.onPasteLastTranscript?.();

    expect(notificationShow).toHaveBeenCalledTimes(1);
  });

  it('shows a recovery failure card when the clipboard changes during dictation', async () => {
    getClipboardSequenceNumber.mockReturnValueOnce(1).mockReturnValueOnce(2);

    const result = {
      text: 'transcribed text',
      intent: 'dictation' as const,
      targetSnapshot: defaultTargetSnapshot,
    };
    await sessionOptions.onResult(result);

    expect(runtimeShellShowFailure).toHaveBeenCalledTimes(1);
    expect(runtimeShellShowFailure.mock.calls[0]?.[1]).toContain('Clipboard changed during Dictation.');
  });

  it('injects corrected formatter output on success', async () => {
    ipcListeners.clear();
    await import(`../index?test=${Date.now()}-corrected-success`);
    applyDictationFormatter.mockResolvedValueOnce({ kind: 'success', text: 'buy eggs' });
    getConfig.mockReturnValue({
      ...baseConfig,
      dictation: {
        mode: 'corrected',
        formatter: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'formatter',
          apiKeyEnvVar: '',
          apiKeySource: 'environment',
          processingConsent: true,
        },
      },
    });

    await sessionOptions.onResult({
      text: 'buy milk um actually buy eggs',
      intent: 'dictation',
      targetSnapshot: defaultTargetSnapshot,
      recordingSessionId: 'session-corrected',
    });

    expect(applyDictationFormatter).toHaveBeenCalledTimes(1);
    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith('buy eggs');
    expect(notificationShow).not.toHaveBeenCalled();
    expect(runtimeShellFinish).toHaveBeenCalled();
  });

  it('inserts raw text and shows degraded notice when formatting fails', async () => {
    ipcListeners.clear();
    await import(`../index?test=${Date.now()}-corrected-fallback`);
    applyDictationFormatter.mockResolvedValueOnce({
      kind: 'fallback',
      rawText: 'complete raw transcript',
      reason: 'deadline',
    });
    getConfig.mockReturnValue({
      ...baseConfig,
      dictation: {
        mode: 'corrected',
        formatter: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'formatter',
          apiKeyEnvVar: '',
          apiKeySource: 'environment',
          processingConsent: true,
        },
      },
    });

    await sessionOptions.onResult({
      text: 'complete raw transcript',
      intent: 'dictation',
      targetSnapshot: defaultTargetSnapshot,
      recordingSessionId: 'session-fallback',
    });

    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith('complete raw transcript');
    expect(notificationShow).toHaveBeenCalledTimes(1);
    expect(runtimeShellFinish).toHaveBeenCalled();
  });

  it('does not invoke the formatter for batch dictation', async () => {
    applyDictationFormatter.mockClear();
    await sessionOptions.onResult({
      text: 'plain text',
      intent: 'dictation',
      targetSnapshot: defaultTargetSnapshot,
      recordingSessionId: 'session-batch',
    });

    expect(applyDictationFormatter).not.toHaveBeenCalled();
    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith('plain text');
  });
});
