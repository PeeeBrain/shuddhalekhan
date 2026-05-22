import { app, ipcMain, dialog, session, shell } from 'electron';
import { createAudioWindow, getAudioWindow } from './audio-window';
import { getRecordingPillWindow } from './recording-pill';
import { getSettingsWindow, openSettingsWindow } from './settings-window';
import { createTray, updateAudioDevices, updateUpdaterStatus } from './tray';
import { showAgentToast, hideAgentToast, handleAgentToastContentSize } from './agent-toast-window';
import { getConfig, setConfig } from './config';
import { setupUpdater, checkForUpdates, getUpdateStatus } from './updater';
import { AgentSidecarManager } from './agent-sidecar';
import { createRecordingSession } from './recording-session';
import { createSidecarEventRouter } from './sidecar-event-router';
import { getSidecarConfigAction } from './sidecar-config-policy';
import { injectIntoFocusedApp } from './inject-text';
import { getAuditRuns, getAuditRunDetail, closeDb } from './audit-db';
import type { AppConfig, AudioDevice, UpdateStatus } from '../types/ipc';
import type { RecordingResult } from './recording-session';

let cachedAgentEnabled = getConfig().agent.enabled;
const sidecarEventRouter = createSidecarEventRouter({
  getSettingsWindow,
  getConfig,
  setConfig,
  showAgentToast,
  openExternal: shell.openExternal,
});
const agentSidecar = new AgentSidecarManager(sidecarEventRouter.handle);
const recordingSession = createRecordingSession(() => cachedAgentEnabled);
const gotSingleInstanceLock = app.requestSingleInstanceLock();

async function routeRecordingResult(result: RecordingResult | null): Promise<void> {
  if (!result?.text) return;
  try {
    if (result.intent === 'agent') {
      handleAgentTranscript(result.text);
      return;
    }

    await injectIntoFocusedApp(result.text);
  } catch (err) {
    console.error('Transcription failed:', err);
    dialog.showErrorBox('Transcription Error', err instanceof Error ? err.message : String(err));
  }
}

function finishRecording(): void {
  void recordingSession.end().then(routeRecordingResult).catch(showTranscriptionError);
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

  const agentRunId = agentSidecar.startRun(text, config);
  console.log(`Started Agent Mode run ${agentRunId}`);
  getSettingsWindow()?.webContents.send('audit:run-updated', agentRunId);
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
  const audioWin = getAudioWindow();
  if (!audioWin) return [];
  // Devices will be enumerated by the renderer and sent back via a different IPC
  // For now, return empty and let the tray update happen from the renderer
  return [];
});

ipcMain.handle('audio:select-device', (_event, deviceId: string) => {
  setConfig('selectedDeviceId', deviceId);
  const audioWin = getAudioWindow();
  if (audioWin && !audioWin.isDestroyed()) {
    audioWin.webContents.send('audio:select-device', deviceId);
  }
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

ipcMain.handle('clipboard:inject-text', async (_event, text: string) => {
  await injectIntoFocusedApp(text);
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
ipcMain.on('audio-window-ready', () => {
  recordingSession.markAudioWindowReady();
});

ipcMain.on('audio-data-ready', async (_event, audioData: ArrayBuffer) => {
  const data = new Uint8Array(audioData);
  console.log(`Audio data ready: ${data.byteLength} bytes`);
  await recordingSession.complete(data);
});

ipcMain.on('audio-devices', (_event, devices: AudioDevice[]) => {
  updateAudioDevices(devices);
});

ipcMain.on('audio-level-changed', (_event, level: number) => {
  const pill = getRecordingPillWindow();
  if (pill && !pill.isDestroyed()) {
    pill.webContents.send('audio:level-changed', level);
  }
});

ipcMain.on('audio-duration-changed', (_event, seconds: number) => {
  const pill = getRecordingPillWindow();
  if (pill && !pill.isDestroyed()) {
    pill.webContents.send('audio:duration-changed', seconds);
  }
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

    const audioWin = createAudioWindow();
    audioWin.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error(`Audio window failed to load: ${errorCode} ${errorDescription}`);
    });
    audioWin.webContents.on('render-process-gone', (_event, details) => {
      recordingSession.markAudioWindowCrashed(details.reason);
    });

    recordingSession.startKeyboardHook(routeRecordingResult);

    createTray(() => {
      openSettingsWindow();
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
    recordingSession.stopKeyboardHook();
    agentSidecar.stop();
    recordingSession.destroyAudioWindow();
    closeDb();
  });
}
