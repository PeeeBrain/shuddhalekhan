import { randomUUID } from 'crypto';
import { app, BrowserWindow, dialog, ipcMain, session, shell, Notification, powerMonitor } from 'electron';

import { getSettingsWindow, openSettingsWindow, setSettingsWindowClosedHandler } from './settings-window';
import { createTray, updateAudioDevices, updateShortcutPauseState, updateUpdaterStatus } from './tray';
import { showAgentToast, hideAgentToast, handleAgentToastContentSize } from './agent-toast-window';
import {
  getConfig,
  getLastSeenReleaseNotesVersion,
  mergeDiscoveredTools,
  setConfig,
  setLastSeenReleaseNotesVersion,
} from './config';
import { credentialVault } from './credential-vault';
import { registerCredentialIpcHandlers } from './credential-ipc';
import { getAgentSidecarApiKey } from './agent-credential';
import { setupUpdater, checkForUpdates, getUpdateStatus } from './updater';
import { getBundledReleaseNotes, getReleaseNotesPreview } from './release-notes';
import { AgentSidecarManager } from './agent-sidecar';
import { RecordingSession } from './recording-session';
import { keyboardHook } from './native/keyboard';
import {
  checkServerReachability,
  getSafeTranscriptionFailureMessage,
  TranscriptionFailure,
  validateProviderReadiness,
} from './transcription';
import { getTranscriber } from './providers';
import { checkWhisperLiveKitReadiness } from './whisper-live-kit';
import { createSidecarEventRouter } from './sidecar-event-router';
import { McpStatusStore } from './mcp-status-store';
import { getSidecarConfigAction } from './sidecar-config-policy';
import { injectIntoFocusedApp, copyLastTranscriptToClipboard } from './inject-text';
import {
  getLastTranscript,
  markLastTranscriptInjected,
  setLastTranscript,
} from './last-transcript';
import { getAuditRuns, getAuditRunDetail, closeDb } from './audit-db';
import type { AppConfig, AudioDevice, InjectResult, McpStatusSnapshot, UpdateStatus } from '../types/ipc';
import type { RecordingResult } from './recording-session';
import { emitPerformanceMarker } from './performance/marker-collector';
import { buildElectronProcessInventory } from './performance/process-inventory';
import { createRuntimeReadinessBarrier } from './performance/runtime-readiness';
import {
  createPerformanceScenarioDriver,
  isPerformanceScenarioDriverEnabled,
  parsePerformanceScenarioDriverConfig,
} from './performance/scenario-driver';
import { transcribe as transcribeLocalFixture } from './whisper';
import { RuntimeShell } from './runtime-shell';
import { getLiveRecoveryActions, getRecoveryActions } from './dictation-recovery';
import { parseMaintainerRuntimeGates } from '../shared/dictation-runtime';
import { outerTrimTranscript } from '../shared/live-dictation';
import { applyDictationFormatter } from './dictation-formatter';
import { getDictationFormatterApiKey } from './dictation-formatter-credential';
import {
  isDictationResultStillDeliverable,
  markDictationResultPending,
} from './dictation-result-delivery';

let cachedAgentEnabled = getConfig().agent.enabled;
let activeAgentRunId: string | null = null;
let retryPasteInFlight = false;
let shellPillReadyEmitted = false;
let startPerformanceScenario = async (): Promise<void> => undefined;
const performanceDriverEnabled = isPerformanceScenarioDriverEnabled(process.env);
const performanceDriverConfig = parsePerformanceScenarioDriverConfig(process.env);
const agentTerminalWaiters = new Map<string, () => void>();
const surfacePaintWaiters = new Map<string, Array<() => void>>();
const runtimeReadiness = createRuntimeReadinessBarrier(() => {
  emitElectronProcessInventory();
  emitPerformanceMarker('runtime.operational');
  queueMicrotask(() => {
    void startPerformanceScenario().catch((error) => {
      console.error('Performance scenario driver failed:', error);
    });
  });
});
const mcpStatusStore = new McpStatusStore();
mcpStatusStore.configure(getConfig().agent.mcpServers);
function publishMcpStatusSnapshot(snapshot: McpStatusSnapshot): void {
  getSettingsWindow()?.webContents.send('mcp:status-snapshot', snapshot);
}
function resetMcpStatusSnapshot(): void {
  publishMcpStatusSnapshot(mcpStatusStore.reset());
}
// A runtime-generation boundary invalidates every live server status.
function notifyAgentRuntimeStopped(message: string): void {
  resetMcpStatusSnapshot();
  showAgentToast({ kind: 'config', message });
}
const sidecarEventRouter = createSidecarEventRouter({
  getSettingsWindow,
  getActiveAgentRunId: () => activeAgentRunId,
  showAgentToast,
  openExternal: shell.openExternal,
  mergeDiscoveredTools,
  getConfig,
  recordMcpStatus: (status) => mcpStatusStore.record(status),
  onAgentTerminal: (agentRunId) => {
    if (activeAgentRunId === agentRunId) activeAgentRunId = null;
    agentTerminalWaiters.get(agentRunId)?.();
    agentTerminalWaiters.delete(agentRunId);
  },
});
const agentSidecar = new AgentSidecarManager(sidecarEventRouter.handle, {
  onLifecycleError: () => {
    notifyAgentRuntimeStopped('Agent runtime could not start securely. Check the logs and try again.');
  },
  onGenerationExit: () => {
    notifyAgentRuntimeStopped('Agent runtime stopped unexpectedly. Try Agent Mode again.');
    if (activeAgentRunId) {
      agentTerminalWaiters.get(activeAgentRunId)?.();
      agentTerminalWaiters.delete(activeAgentRunId);
      activeAgentRunId = null;
    }
  },
});
const runtimeGates = parseMaintainerRuntimeGates(process.env);
const runtimeShell = runtimeGates.runtimeShell
  ? new RuntimeShell()
  : null;
const recordingSession = new RecordingSession({
  runtimeGates,
  ...(runtimeShell ? { runtimeShell } : {}),
  isAgentModeEnabled: () => cachedAgentEnabled,
  getRecordingActivationMode: (intent) => getConfig().shortcuts[intent].activationMode,
  getShortcutBinding: (intent) => getConfig().shortcuts[intent].binding,
  getSelectedDeviceId: () => getConfig().selectedDeviceId,
  getDictationMode: () => getConfig().dictation.mode,
  getRecognitionSettings: () => {
    const config = getConfig();
    return {
      language: config.language,
      task: config.task,
      dictionary: config.dictionary,
      removeFillerWords: config.removeFillerWords,
    };
  },
  getTranscriber: () => getTranscriber(getConfig(), credentialVault),
  getReadinessError: () => {
    const config = getConfig();
    const errors = validateProviderReadiness(
      config.transcription.activeProvider,
      config,
      credentialVault,
    );
    return errors[0] ? new TranscriptionFailure('endpoint', errors[0]) : null;
  },
  onResult: routeRecordingResult,
  onError: showTranscriptionError,
});
runtimeShell?.setCrashHandler((reason) => recordingSession.markRuntimeShellCrashed(reason));
const performanceScenarioDriver = createPerformanceScenarioDriver(
  performanceDriverConfig,
  {
    openSettings: async () => {
      const painted = waitForSurfacePaint('settings');
      openSettingsWindow();
      await painted;
    },
    getConfig,
    async runRecording({ wav, playbackDurationMs, transcriptionEndpoint }) {
      const config = getConfig();
      const fixtureConfig: AppConfig = {
        ...config,
        whisperUrl: transcriptionEndpoint,
        transcription: {
          ...config.transcription,
          activeProvider: 'local-whisper-cpp',
          providers: {
            ...config.transcription.providers,
            localWhisperCpp: { endpoint: transcriptionEndpoint },
          },
        },
      };
      await recordingSession.runPerformanceFixture(wav, playbackDurationMs, {
        id: 'local-whisper-cpp',
        capabilities: {
          translation: true,
          automaticLanguageDetection: true,
          dictionaryHints: true,
          authentication: 'none',
          maxDurationSeconds: null,
        },
        transcribe: ({ audio }) => transcribeLocalFixture(audio, fixtureConfig),
      });
    },
    runAgent: ({ transcript, config }) => startAgentRun(transcript, config),
  },
);
startPerformanceScenario = () => performanceScenarioDriver.start();
const gotSingleInstanceLock = app.requestSingleInstanceLock();

async function routeRecordingResult(result: RecordingResult | null): Promise<void> {
  if (!result?.text) return;

  if (result.intent === 'agent') {
    handleAgentTranscript(result.text);
    return;
  }

  const sessionId = result.recordingSessionId;
  markDictationResultPending(sessionId);

  const live = result.liveDictation;
  const liveDispatch = live ? {
    hasAcceptedEvents: live.hasAcceptedEvents,
    uncertain: live.uncertain,
  } : undefined;

  if (live) {
    setLastTranscript(result.text, result.targetSnapshot, liveDispatch);

    if (result.outcome.kind === 'failed') {
      markLastTranscriptInjected(live.hasAcceptedEvents || live.uncertain ? 'uncertain' : 'failed');
      const message = 'Live Dictation could not complete. Last Transcript contains Recognized So Far.';
      const actions = getLiveRecoveryActions(live);
      if (runtimeShell) {
        runtimeShell.showFailure(result.recordingSessionId, message, actions);
      } else {
        showRecoveryNotification(
          { kind: 'input-blocked', acceptedEvents: live.hasAcceptedEvents || live.uncertain ? 1 : 0, reason: message },
          'Live Dictation stopped',
        );
      }
      return;
    }

    const projectedFull = outerTrimTranscript(result.text);
    const sameTranscript = outerTrimTranscript(live.rawCommitted) === projectedFull;
    const fullyDispatched = sameTranscript
      && live.dispatchedProjectedLength >= projectedFull.length;

    if (live.hasAcceptedEvents || live.uncertain) {
      const uncertain = live.uncertain || !fullyDispatched;
      markLastTranscriptInjected(uncertain ? 'uncertain' : 'dispatched');
      if (uncertain) {
        const message = !fullyDispatched
          ? 'Live Dictation stopped before the full transcript was inserted.'
          : 'Live Dictation stopped because Windows could not confirm the last insertion.';
        if (runtimeShell) {
          runtimeShell.showFailure(
            result.recordingSessionId,
            message,
            getLiveRecoveryActions(live),
          );
        } else {
          showRecoveryNotification(
            { kind: 'input-blocked', acceptedEvents: 1, reason: message },
            'Live Dictation stopped',
          );
        }
      }
      return;
    }

    const fallbackText = outerTrimTranscript(result.text);
    const injectResult = await injectIntoFocusedApp(fallbackText, result.targetSnapshot);
    if (injectResult.kind === 'input-dispatched') {
      markLastTranscriptInjected('dispatched');
      return;
    }
    markLastTranscriptInjected('failed');
    runtimeShell?.showFailure(
      result.recordingSessionId,
      getRecoveryMessage(injectResult),
      getRecoveryActions(injectResult),
    );
    return;
  }

  const config = getConfig();
  let text = result.text;
  let formatterDegraded = false;

  if (
    config.dictation.mode === 'corrected'
    && config.dictation.formatter?.processingConsent
  ) {
    if (runtimeShell) runtimeShell.showProcessing(sessionId);
    const outcome = await applyDictationFormatter({
      profile: config.dictation.formatter,
      rawText: result.text,
      language: config.language,
      protectedTerms: config.dictionary,
      apiKey: getDictationFormatterApiKey(config.dictation.formatter, credentialVault),
    });
    if (!isDictationResultStillDeliverable(sessionId)) return;
    if (outcome.kind === 'fallback') {
      text = outcome.rawText;
      formatterDegraded = true;
    } else {
      text = outcome.text;
    }
  }

  if (!isDictationResultStillDeliverable(sessionId)) return;

  setLastTranscript(text, result.targetSnapshot);

  const injectResult = await injectIntoFocusedApp(text, result.targetSnapshot);
  if (injectResult.kind === 'input-dispatched') {
    markLastTranscriptInjected('dispatched');
    if (formatterDegraded) showFormatterDegradedNotice();
    runtimeShell?.finish();
    return;
  }

  markLastTranscriptInjected('failed');
  if (runtimeShell) {
    runtimeShell.showFailure(
      result.recordingSessionId,
      getRecoveryMessage(injectResult),
      getRecoveryActions(injectResult),
    );
  } else {
    showRecoveryNotification(injectResult);
  }
}

function showFormatterDegradedNotice(): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: 'Corrected Dictation',
    body: 'Formatting was unavailable; your complete raw transcript was inserted.',
    silent: true,
  }).show();
}

async function pasteLastTranscript(): Promise<void> {
  const transcript = getLastTranscript();
  if (!transcript) return;
  if (transcript.liveDispatch?.hasAcceptedEvents || transcript.liveDispatch?.uncertain) {
    showLiveCopyOnlyNotification();
    return;
  }

  const result = await injectIntoFocusedApp(transcript.text);
  if (result.kind !== 'input-dispatched') {
    showRecoveryNotification(result, 'Paste Last Transcript failed');
  }
}

function showLiveCopyOnlyNotification(): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: 'Paste Last Transcript unavailable',
    body: 'Live Dictation may already have inserted this text. Use Copy Last Transcript to avoid duplication.',
    silent: true,
  }).show();
}

async function copyLastTranscript(): Promise<void> {
  const transcript = getLastTranscript();
  if (!transcript) return;
  await copyLastTranscriptToClipboard(transcript.text);
}

function showRecoveryNotification(result: InjectResult, title = 'Dictation Paste Failed'): void {
  let body: string;
  let detail = '';

  if (result.kind === 'clipboard-conflict') {
    body = 'Clipboard changed during dictation; use the tray to paste or copy the last transcript.';
  } else {
    detail = result.kind === 'error' ? `: ${result.message}`
      : result.kind === 'input-blocked' && result.reason ? `: ${result.reason}`
      : result.kind === 'target-changed' && result.reason ? `: ${result.reason}`
      : '';
    body = `Automatic paste failed${detail}. Use the tray to paste or copy the last transcript.`;
  }

  console.warn('Dictation recovery:', result.kind, detail);

  if (Notification.isSupported()) {
    new Notification({
      title,
      body,
      silent: true,
    }).show();
  }
}

function getRecoveryMessage(result: InjectResult): string {
  if (result.kind === 'clipboard-conflict') {
    return 'Clipboard changed before Shuddhalekhan could paste the transcript.';
  }
  if (result.kind === 'target-changed') return result.reason;
  if (result.kind === 'input-blocked') return result.reason ?? 'Windows blocked automatic paste.';
  if (result.kind === 'error') return result.message;
  return 'Automatic paste failed.';
}

async function handleRuntimeRecoveryAction(action: import('../types/ipc').DictationRecoveryAction): Promise<void> {
  const transcript = getLastTranscript();
  if (!runtimeShell || !transcript) return;
  if (action === 'copy-full-transcript') {
    await copyLastTranscriptToClipboard(transcript.text);
    runtimeShell.finish();
    return;
  }
  if (action !== 'retry-paste') return;
  if (retryPasteInFlight) return;
  retryPasteInFlight = true;
  try {
    runtimeShell.finish();
    const result = await injectIntoFocusedApp(transcript.text, transcript.targetSnapshot);
    if (result.kind === 'input-dispatched') {
      markLastTranscriptInjected('dispatched');
      return;
    }
    markLastTranscriptInjected('failed');
    runtimeShell.showFailure(null, getRecoveryMessage(result), getRecoveryActions(result));
  } finally {
    retryPasteInFlight = false;
  }
}

function finishRecording(): void {
  void recordingSession.end().catch((err) => {
    console.error('Recording end failed:', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  });
}

// Never leave global shortcut activation suspended after capture ends.
setSettingsWindowClosedHandler(() => keyboardHook.setCaptureSuspended(false));

function setShortcutsPaused(paused: boolean): void {
  keyboardHook.setPaused(paused);
  updateShortcutPauseState(paused);
  const settingsWin = getSettingsWindow();
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('shortcuts:paused-changed', paused);
  }
}

function showTranscriptionError(err: unknown): void {
  const message = getSafeTranscriptionFailureMessage(err);
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : 'Unknown failure';
  console.error(`Transcription failed (${detail}):`, message);
  if (runtimeShell) {
    runtimeShell.showFailure(null, message);
    return;
  }
  showAgentToast({
    kind: 'transcription-failed',
    message,
  });
}

function handleAgentTranscript(text: string): void {
  void startAgentRun(text, getConfig());
}

function startAgentRun(text: string, config: AppConfig): Promise<void> {
  if (!config.agent.enabled) {
    console.warn('Ignoring Agent Mode transcript because Agent Mode is disabled');
    showAgentToast({ kind: 'config', message: 'Agent Mode is disabled. Open Settings to enable it.' });
    return Promise.resolve();
  }

  if (activeAgentRunId) {
    agentTerminalWaiters.get(activeAgentRunId)?.();
    agentTerminalWaiters.delete(activeAgentRunId);
    agentSidecar.cancelRun(activeAgentRunId);
  }

  activeAgentRunId = randomUUID();
  const terminal = new Promise<void>((resolve) => {
    agentTerminalWaiters.set(activeAgentRunId!, resolve);
  });
  agentSidecar.startRun(
    activeAgentRunId,
    text,
    config,
    getAgentSidecarApiKey(config, credentialVault),
  );
  console.log(`Started Agent Mode run ${activeAgentRunId}`);
  getSettingsWindow()?.webContents.send('audit:run-updated', activeAgentRunId);
  return terminal;
}

function waitForSurfacePaint(surface: string): Promise<void> {
  return new Promise((resolve) => {
    const waiters = surfacePaintWaiters.get(surface) ?? [];
    waiters.push(resolve);
    surfacePaintWaiters.set(surface, waiters);
  });
}

function publishUpdateStatus(status: UpdateStatus): void {
  updateUpdaterStatus(status);
  const settingsWin = getSettingsWindow();
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('updater:status-changed', status);
  }
}

function emitElectronProcessInventory(): void {
  const windows = BrowserWindow.getAllWindows().flatMap((window) => {
    try {
      return [{
        webContentsId: window.webContents.id,
        pid: window.webContents.getOSProcessId(),
        url: window.webContents.getURL(),
      }];
    } catch {
      return [];
    }
  });
  const inventory = buildElectronProcessInventory(app.getAppMetrics(), windows);
  emitPerformanceMarker('process.inventory', inventory);
}

async function showBundledReleaseNotesAfterInstall(): Promise<void> {
  const releaseNotes = getBundledReleaseNotes();
  if (
    !releaseNotes ||
    getLastSeenReleaseNotesVersion() === releaseNotes.version
  ) {
    return;
  }

  try {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: "What's New",
      message: `Shuddhalekhan v${releaseNotes.version} is installed.`,
      detail: getReleaseNotesPreview([releaseNotes]),
      buttons: ["View What's New", 'Close'],
      defaultId: 0,
      cancelId: 1,
    });
    setLastSeenReleaseNotesVersion(releaseNotes.version);
    if (response === 0) {
      openSettingsWindow('about');
    }
  } catch {
    // A failed informational dialog must not prevent app startup.
  }
}

// IPC handlers
registerCredentialIpcHandlers(ipcMain, credentialVault);

ipcMain.handle('audio:start-recording', () => {
  recordingSession.begin('dictation');
});

ipcMain.handle('audio:stop-recording', async () => {
  finishRecording();
  return 'stopped';
});

ipcMain.handle('audio:get-devices', async () => {
  const webContents = recordingSession.getAudioWebContents();
  if (!webContents) return [];
  // Devices will be enumerated by the renderer and sent back via a different IPC
  // For now, return empty and let the tray update happen from the renderer
  return [];
});

ipcMain.handle('audio:select-device', (_event, deviceId: string) => {
  setConfig('selectedDeviceId', deviceId);
  recordingSession.updateDevice(deviceId);
});

ipcMain.handle('config:get', () => {
  return getConfig();
});

ipcMain.handle('shortcuts:get-paused', () => {
  return keyboardHook.isPaused();
});

ipcMain.handle('shortcuts:set-paused', (_event, paused: boolean) => {
  setShortcutsPaused(Boolean(paused));
  return keyboardHook.isPaused();
});

ipcMain.handle('shortcuts:begin-capture', () => {
  keyboardHook.setCaptureSuspended(true);
});

ipcMain.handle('shortcuts:end-capture', () => {
  keyboardHook.setCaptureSuspended(false);
});

ipcMain.handle('transcription:check-server', async () => {
  const config = getConfig();
  const provider = config.transcription.activeProvider;

  if (provider === 'local-whisper-cpp') {
    return checkServerReachability(config.transcription.providers.localWhisperCpp.endpoint);
  }

  // OpenAI Cloud: local-only, zero fetches
  if (provider === 'openai') {
    return false;
  }

  if (provider === 'nvidia-speech-nim') {
    const { endpoint, auth } = config.transcription.providers.nvidiaSpeechNim;
    if (auth !== 'none') return false;
    return checkServerReachability(endpoint);
  }

  // Custom with auth: local-only, zero fetches
  if (provider === 'custom-open-ai-compatible') {
    const { endpoint, auth } = config.transcription.providers.customOpenAiCompatible;
    if (auth !== 'none') return false;
    return checkServerReachability(endpoint);
  }

  return false;
});

ipcMain.handle('transcription:check-readiness', async () => {
  const config = getConfig();
  const provider = config.transcription.activeProvider;
  if (provider !== 'whisper-live-kit') {
    return {
      providerId: provider,
      state: 'ready' as const,
      message: 'The selected batch provider is ready for recording.',
      checkedAt: new Date().toISOString(),
    };
  }

  const checking = {
    providerId: provider,
    state: 'checking' as const,
    message: 'Checking WhisperLiveKit health and PCM WebSocket readiness...',
    checkedAt: null,
  };
  getSettingsWindow()?.webContents.send('transcription:readiness-changed', checking);

  const providerConfig = config.transcription.providers.whisperLiveKit;
  const readiness = await checkWhisperLiveKitReadiness(
    providerConfig ?? { baseUrl: '', auth: 'none' },
    providerConfig?.auth === 'bearer' ? credentialVault.read('whisper-live-kit-bearer') : null,
  );
  getSettingsWindow()?.webContents.send('transcription:readiness-changed', readiness);
  return readiness;
});

ipcMain.handle('config:set', async (_event, key: keyof AppConfig, value: AppConfig[keyof AppConfig]) => {
  const previousConfig = getConfig();
  setConfig(key, value);
  const config = getConfig();
  if (key === 'agent') {
    publishMcpStatusSnapshot(mcpStatusStore.configure(config.agent.mcpServers));
  }
  cachedAgentEnabled = config.agent.enabled;
  const sidecarAction = getSidecarConfigAction(previousConfig, config);
  if (sidecarAction === 'stop') {
    await agentSidecar.stop();
    resetMcpStatusSnapshot();
  } else if (sidecarAction === 'start') {
    agentSidecar.start(config, getAgentSidecarApiKey(config, credentialVault));
  }
});

ipcMain.handle('mcp:test-server', async (_event, serverId: string) => {
  const config = getConfig();
  const server = config.agent.mcpServers.find((item) => item.id === serverId);
  if (!server) return;

  const sidecarConfig = {
    ...config,
    agent: {
      ...config.agent,
      enabled: true,
      mcpServers: config.agent.mcpServers.map((item) => ({
        ...item,
        enabled: item.id === serverId ? true : item.enabled,
      })),
    },
  };
  await agentSidecar.stop();
  resetMcpStatusSnapshot();
  agentSidecar.start(sidecarConfig, getAgentSidecarApiKey(sidecarConfig, credentialVault));
});

ipcMain.handle('mcp:get-status-snapshot', () => mcpStatusStore.getSnapshot());

ipcMain.handle('settings:open', () => {
  openSettingsWindow();
});

ipcMain.handle('clipboard:inject-text', async (_event, text: string): Promise<InjectResult> => {
  return injectIntoFocusedApp(text);
});

ipcMain.handle(
  'agent:approval-decision',
  (_event, agentRunId: string, approvalId: string, decision: 'approved' | 'denied', message?: string) => {
    agentSidecar.sendApprovalDecision(agentRunId, approvalId, decision, message);
  }
);

ipcMain.handle('app:get-info', async () => {
  return {
    name: app.name,
    version: app.getVersion(),
    isPackaged: app.isPackaged,
  };
});

ipcMain.handle('app:get-release-notes', () => {
  return getBundledReleaseNotes();
});

ipcMain.handle('updater:get-status', () => {
  return getUpdateStatus();
});

ipcMain.handle('updater:check', async () => {
  return checkForUpdates();
});

ipcMain.handle('audit:get-runs', async () => {
  return getAuditRuns();
});

ipcMain.handle('audit:get-run-detail', async (_event, agentRunId: string) => {
  return getAuditRunDetail(agentRunId);
});

// Renderer -> Main events
ipcMain.on('audio-devices', (_event, devices: AudioDevice[]) => {
  updateAudioDevices(devices);
});

ipcMain.on('agent-toast:content-size', (_event, height: number) => {
  handleAgentToastContentSize(height);
});

ipcMain.on('agent-toast:dismiss', () => {
  hideAgentToast();
});

ipcMain.on('runtime:recovery-action', (_event, action) => {
  void handleRuntimeRecoveryAction(action).catch((err) => {
    console.error('Failed to handle runtime recovery action:', err);
  });
});

ipcMain.on('surface-paint-proxy', (_event, surface: string, correlationId?: string) => {
  emitPerformanceMarker('surface.paint-proxy', {
    surface,
    ...(surface === 'recording' && correlationId ? { recordingSessionId: correlationId } : {}),
  });
  if (surface === 'recording') {
    if (!shellPillReadyEmitted) {
      shellPillReadyEmitted = true;
      emitPerformanceMarker('shell.pill.ready');
    }
    runtimeReadiness.markShellPaintReady();
  }
  emitElectronProcessInventory();
  for (const resolve of surfacePaintWaiters.get(surface) ?? []) resolve();
  surfacePaintWaiters.delete(surface);
});

// App lifecycle
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    emitPerformanceMarker('app.electron-ready');
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'media');
    });

    recordingSession.start();
    const failClosed = () => { void recordingSession.cancel(); };
    powerMonitor.on('suspend', failClosed);
    powerMonitor.on('lock-screen', failClosed);

    createTray({
      onOpenSettings: () => openSettingsWindow(),
      onPasteLastTranscript: () => pasteLastTranscript(),
      onCopyLastTranscript: () => copyLastTranscript(),
      onCheckForUpdates: () => void checkForUpdates(),
      isShortcutsPaused: () => keyboardHook.isPaused(),
      onTogglePause: (paused: boolean) => setShortcutsPaused(paused),
      onSelectDevice: (deviceId: string) => {
        setConfig('selectedDeviceId', deviceId);
        recordingSession.updateDevice(deviceId);
      },
    });

    emitPerformanceMarker('tray.ready');
    emitPerformanceMarker('hotkey-hook.ready');

    const startupConfig = getConfig();
    cachedAgentEnabled = startupConfig.agent.enabled;
    if (startupConfig.agent.enabled) {
      resetMcpStatusSnapshot();
      agentSidecar.start(
        startupConfig,
        getAgentSidecarApiKey(startupConfig, credentialVault),
      );
    }

    if (!performanceDriverEnabled) {
      setupUpdater(publishUpdateStatus, () => openSettingsWindow('about'));
      publishUpdateStatus(getUpdateStatus());
      void showBundledReleaseNotesAfterInstall();
    }
    runtimeReadiness.markMainReady();

    app.on('activate', () => {
      // Keep running in tray; no main window to recreate
    });
  });

  app.on('window-all-closed', () => {
    // Keep running in tray on Windows
  });

  let quitCleanupStarted = false;
  let quitCleanupComplete = false;
  app.on('before-quit', (event) => {
    if (quitCleanupComplete) return;
    event.preventDefault();
    if (quitCleanupStarted) return;
    quitCleanupStarted = true;
    void recordingSession.cancel();
    recordingSession.stop();
    void agentSidecar.stop().finally(() => {
      resetMcpStatusSnapshot();
      closeDb();
      quitCleanupComplete = true;
      app.quit();
    });
  });
}
