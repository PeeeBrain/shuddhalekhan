import { randomUUID } from 'crypto';
import { app, ipcMain, dialog, session, shell, Notification } from 'electron';

import { getSettingsWindow, openSettingsWindow } from './settings-window';
import { createTray, updateAudioDevices, updateUpdaterStatus } from './tray';
import { showAgentToast, hideAgentToast, handleAgentToastContentSize } from './agent-toast-window';
import { getConfig, setConfig } from './config';
import { setupUpdater, checkForUpdates, getUpdateStatus } from './updater';
import { AgentSidecarManager } from './agent-sidecar';
import { RecordingSession } from './recording-session';
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
  getSelectedDeviceId: () => getConfig().selectedDeviceId,
  getWhisperUrl: () => getConfig().whisperUrl,
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

function copyLastTranscript(): void {
  const transcript = getLastTranscript();
  if (!transcript) return;
  copyLastTranscriptToClipboard(transcript.text);
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

function showTranscriptionError(err: unknown): void {
  console.error('Transcription failed:', err);
  dialog.showErrorBox('Transcription Error', err instanceof Error ? err.message : String(err));
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
  agentSidecar.startRun(activeAgentRunId, text, config);
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

ipcMain.handle('config:set', (_event, key: keyof AppConfig, value: AppConfig[keyof AppConfig]) => {
  const previousConfig = getConfig();
  setConfig(key, value);
  const config = getConfig();
  cachedAgentEnabled = config.agent.enabled;
  const sidecarAction = getSidecarConfigAction(previousConfig, config);
  if (sidecarAction === 'stop') {
    agentSidecar.stop();
  } else if (sidecarAction === 'start') {
    agentSidecar.start(config);
  }
});

ipcMain.handle('mcp:test-server', (_event, serverId: string) => {
  const config = getConfig();
  const server = config.agent.mcpServers.find((item) => item.id === serverId);
  if (!server) return;

  agentSidecar.start({
    ...config,
    agent: {
      ...config.agent,
      enabled: true,
      mcpServers: config.agent.mcpServers.map((item) => ({
        ...item,
        enabled: item.id === serverId ? true : item.enabled,
      })),
    },
  });
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
