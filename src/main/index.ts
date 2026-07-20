import { randomUUID } from 'crypto';
import { app, ipcMain, session, shell, Notification } from 'electron';

import { getSettingsWindow, openSettingsWindow, setSettingsWindowClosedHandler } from './settings-window';
import { createTray, updateAudioDevices, updateShortcutPauseState, updateUpdaterStatus } from './tray';
import { showAgentToast, hideAgentToast, handleAgentToastContentSize } from './agent-toast-window';
import { getConfig, setConfig } from './config';
import { credentialVault } from './credential-vault';
import { registerCredentialIpcHandlers } from './credential-ipc';
import { getAgentSidecarApiKey } from './agent-credential';
import { setupUpdater, checkForUpdates, getUpdateStatus } from './updater';
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
import { createSidecarEventRouter } from './sidecar-event-router';
import { getSidecarConfigAction } from './sidecar-config-policy';
import { injectIntoFocusedApp, copyLastTranscriptToClipboard } from './inject-text';
import {
  getLastTranscript,
  markLastTranscriptInjected,
  setLastTranscript,
} from './last-transcript';
import { getAuditRuns, getAuditRunDetail, closeDb } from './audit-db';
import type { AppConfig, AudioDevice, InjectResult, UpdateStatus } from '../types/ipc';
import type { RecordingResult } from './recording-session';

let cachedAgentEnabled = getConfig().agent.enabled;
let activeAgentRunId: string | null = null;
const sidecarEventRouter = createSidecarEventRouter({
  getSettingsWindow,
  getActiveAgentRunId: () => activeAgentRunId,
  showAgentToast,
  openExternal: shell.openExternal,
});
const agentSidecar = new AgentSidecarManager(sidecarEventRouter.handle);
const recordingSession = new RecordingSession({
  isAgentModeEnabled: () => cachedAgentEnabled,
  getRecordingActivationMode: (intent) => getConfig().shortcuts[intent].activationMode,
  getShortcutBinding: (intent) => getConfig().shortcuts[intent].binding,
  getSelectedDeviceId: () => getConfig().selectedDeviceId,
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
const gotSingleInstanceLock = app.requestSingleInstanceLock();

async function routeRecordingResult(result: RecordingResult | null): Promise<void> {
  if (!result?.text) return;

  if (result.intent === 'agent') {
    handleAgentTranscript(result.text);
    return;
  }

  setLastTranscript(result.text);

  const injectResult = await injectIntoFocusedApp(result.text, result.targetSnapshot);
  if (injectResult.kind === 'input-dispatched') {
    markLastTranscriptInjected('dispatched');
    return;
  }

  markLastTranscriptInjected('failed');
  showRecoveryNotification(injectResult);
}

async function pasteLastTranscript(): Promise<void> {
  const transcript = getLastTranscript();
  if (!transcript) return;

  const result = await injectIntoFocusedApp(transcript.text);
  if (result.kind !== 'input-dispatched') {
    showRecoveryNotification(result, 'Paste Last Transcript failed');
  }
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

function finishRecording(): void {
  void recordingSession.end();
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
  console.error('Transcription failed:', err instanceof Error ? err.name : 'Unknown failure');
  showAgentToast({
    kind: 'transcription-failed',
    message: getSafeTranscriptionFailureMessage(err),
  });
}

function handleAgentTranscript(text: string): void {
  const config = getConfig();

  if (!config.agent.enabled) {
    console.warn('Ignoring Agent Mode transcript because Agent Mode is disabled');
    showAgentToast({ kind: 'config', message: 'Agent Mode is disabled. Open Settings to enable it.' });
    return;
  }

  if (activeAgentRunId) {
    agentSidecar.cancelRun(activeAgentRunId);
  }

  activeAgentRunId = randomUUID();
  agentSidecar.startRun(
    activeAgentRunId,
    text,
    config,
    getAgentSidecarApiKey(config, credentialVault),
  );
  console.log(`Started Agent Mode run ${activeAgentRunId}`);
  getSettingsWindow()?.webContents.send('audit:run-updated', activeAgentRunId);
}

function publishUpdateStatus(status: UpdateStatus): void {
  updateUpdaterStatus(status);
  const settingsWin = getSettingsWindow();
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('updater:status-changed', status);
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

ipcMain.handle('config:set', (_event, key: keyof AppConfig, value: AppConfig[keyof AppConfig]) => {
  const previousConfig = getConfig();
  setConfig(key, value);
  const config = getConfig();
  cachedAgentEnabled = config.agent.enabled;
  const sidecarAction = getSidecarConfigAction(previousConfig, config);
  if (sidecarAction === 'stop') {
    agentSidecar.stop();
  } else if (sidecarAction === 'start') {
    agentSidecar.start(config, getAgentSidecarApiKey(config, credentialVault));
  }
});

ipcMain.handle('mcp:test-server', (_event, serverId: string) => {
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
  agentSidecar.start(sidecarConfig, getAgentSidecarApiKey(sidecarConfig, credentialVault));
});

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

// App lifecycle
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'media');
    });

    recordingSession.start();

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

    const startupConfig = getConfig();
    cachedAgentEnabled = startupConfig.agent.enabled;
    if (startupConfig.agent.enabled) {
      agentSidecar.start(startupConfig);
    }

    setupUpdater(publishUpdateStatus);
    publishUpdateStatus(getUpdateStatus());

    app.on('activate', () => {
      // Keep running in tray; no main window to recreate
    });
  });

  app.on('window-all-closed', () => {
    // Keep running in tray on Windows
  });

  app.on('before-quit', () => {
    recordingSession.stop();
    agentSidecar.stop();
    closeDb();
  });
}
