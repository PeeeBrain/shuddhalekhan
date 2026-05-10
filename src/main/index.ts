import { app, ipcMain, clipboard, dialog, session, shell } from 'electron';
import { keyboardHook } from './native/keyboard';
import { simulatePaste } from './native/clipboard';
import { createAudioWindow, getAudioWindow, destroyAudioWindow } from './audio-window';
import { showRecordingPill, hideRecordingPill, getRecordingPillWindow } from './recording-pill';
import { getSettingsWindow, openSettingsWindow } from './settings-window';
import { createTray, updateAudioDevices, updateUpdaterStatus } from './tray';
import { showAgentToast, hideAgentToast, handleAgentToastContentSize } from './agent-toast-window';
import { getConfig, setConfig } from './config';
import { transcribe } from './whisper';
import { setupUpdater, checkForUpdates, getUpdateStatus } from './updater';
import { AgentSidecarManager } from './agent-sidecar';
import type { AppConfig, AudioDevice, McpDiscoveredTool, RecordingIntent, UpdateStatus } from '../types/ipc';

let isRecording = false;
let isAudioWindowReady = false;
let pendingStartRecording = false;
let activeRecordingIntent: RecordingIntent | null = null;
let cachedAgentEnabled = getConfig().agent.enabled;
const agentSidecar = new AgentSidecarManager((event) => {
  switch (event.type) {
    case 'sidecar:ready':
      console.log('Agent sidecar ready');
      break;
    case 'mcp:server-status':
      console.log(`MCP server ${event.serverId}: ${event.status}`);
      getSettingsWindow()?.webContents.send('mcp:server-status', {
        serverId: event.serverId,
        status: event.status,
        message: event.message,
      });
      break;
    case 'mcp:tools-discovered':
      persistDiscoveredTools(event.serverId, event.tools);
      break;
    case 'oauth:open-url':
      shell.openExternal(event.url).catch((err) => {
        console.error(`Failed to open OAuth URL for ${event.serverId}:`, err);
      });
      break;
    case 'agent:status':
      console.log(`Agent run ${event.agentRunId}: ${event.status}`);
      showAgentToast({ kind: 'status', agentRunId: event.agentRunId, message: event.status });
      break;
    case 'agent:response-delta':
      showAgentToast({ kind: 'streaming', agentRunId: event.agentRunId, response: event.response });
      break;
    case 'approval:requested':
      console.log(`Agent run ${event.agentRunId} requested approval for ${event.serverId}:${event.toolName}`);
      showAgentToast({
        kind: 'status',
        agentRunId: event.agentRunId,
        message: `Waiting for approval: ${event.serverId}.${event.toolName}`,
      });
      showAgentToast({
        kind: 'approval',
        agentRunId: event.agentRunId,
        approvalId: event.approvalId,
        serverId: event.serverId,
        toolName: event.toolName,
        modelToolName: event.modelToolName,
        arguments: event.arguments,
        expiresAt: event.expiresAt,
      });
      break;
    case 'agent:completed':
      console.log(`Agent run ${event.agentRunId} completed: ${event.response}`);
      showAgentToast({
        kind: 'completed',
        agentRunId: event.agentRunId,
        response: event.response,
        toolSummary: event.toolSummary,
      });
      break;
    case 'agent:failed':
      console.error(`Agent run ${event.agentRunId} failed: ${event.error}`);
      showAgentToast({ kind: 'failed', agentRunId: event.agentRunId, error: event.error });
      break;
    case 'agent:cancelled':
      console.log(`Agent run ${event.agentRunId} cancelled`);
      showAgentToast({ kind: 'cancelled', agentRunId: event.agentRunId });
      break;
  }
});
const gotSingleInstanceLock = app.requestSingleInstanceLock();

function persistDiscoveredTools(
  serverId: string,
  tools: Array<{ name: string; description: string; inputSchema?: unknown }>
): void {
  const config = getConfig();
  const discoveredAt = new Date().toISOString();
  const nextServers = config.agent.mcpServers.map((server) => {
    if (server.id !== serverId) return server;

    const discoveredTools: McpDiscoveredTool[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      discoveredAt,
    }));
    const toolPolicies = { ...server.toolPolicies };
    for (const tool of discoveredTools) {
      const key = `${server.id}:${tool.name}` as const;
      if (!toolPolicies[key]) toolPolicies[key] = 'alwaysAsk';
    }

    return {
      ...server,
      discoveredTools,
      toolPolicies,
    };
  });

  setConfig('agent', {
    ...config.agent,
    mcpServers: nextServers,
  });
}

function startRecording(intent: RecordingIntent = 'dictation'): void {
  if (isRecording) return;
  isRecording = true;
  activeRecordingIntent = intent;

  const audioWin = createAudioWindow();
  if (isAudioWindowReady && !audioWin.webContents.isLoading()) {
    audioWin.webContents.send('audio:start-recording');
  } else {
    pendingStartRecording = true;
    console.log('Queued recording start until audio window is ready');
  }

  showRecordingPill(intent);
}

async function stopRecording(): Promise<void> {
  if (!isRecording) return;
  isRecording = false;

  hideRecordingPill();

  const audioWin = getAudioWindow();
  if (audioWin && !audioWin.isDestroyed()) {
    audioWin.webContents.send('audio:stop-recording');
  }
}

async function handleTranscription(audioData: Uint8Array): Promise<void> {
  const intent = activeRecordingIntent ?? 'dictation';
  activeRecordingIntent = null;

  if (audioData.byteLength <= 44) {
    console.warn(`Skipping empty WAV payload: ${audioData.byteLength} bytes`);
    return;
  }

  try {
    const text = await transcribe(audioData);
    if (!text) return;

    if (intent === 'agent') {
      handleAgentTranscript(text);
      return;
    }

    // Clipboard sandwich
    const originalClipboard = clipboard.readText();

    clipboard.writeText(text);
    await delay(50);

    simulatePaste();
    await delay(100);

    // Restore original clipboard
    if (originalClipboard) {
      clipboard.writeText(originalClipboard);
    }
  } catch (err) {
    console.error('Transcription failed:', err);
    dialog.showErrorBox('Transcription Error', err instanceof Error ? err.message : String(err));
  }
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
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  startRecording('dictation');
});

ipcMain.handle('audio:stop-recording', async () => {
  await stopRecording();
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
  setConfig(key, value);
  const config = getConfig();
  cachedAgentEnabled = config.agent.enabled;
  if (!config.agent.enabled) {
    agentSidecar.stop();
  } else {
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

ipcMain.handle('clipboard:inject-text', (_event, text: string) => {
  const originalClipboard = clipboard.readText();
  clipboard.writeText(text);
  setTimeout(() => {
    simulatePaste();
    setTimeout(() => {
      if (originalClipboard) {
        clipboard.writeText(originalClipboard);
      }
    }, 100);
  }, 50);
});

ipcMain.handle(
  'agent:approval-decision',
  (_event, agentRunId: string, approvalId: string, decision: 'approved' | 'denied', message?: string) => {
    agentSidecar.sendApprovalDecision(agentRunId, approvalId, decision, message);
    hideAgentToast();
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

// Renderer -> Main events
ipcMain.on('audio-window-ready', () => {
  isAudioWindowReady = true;
  console.log('Audio window ready');

  if (pendingStartRecording && isRecording) {
    pendingStartRecording = false;
    const audioWin = getAudioWindow();
    if (audioWin && !audioWin.isDestroyed()) {
      audioWin.webContents.send('audio:start-recording');
    }
  }
});

ipcMain.on('audio-data-ready', async (_event, audioData: ArrayBuffer) => {
  const data = new Uint8Array(audioData);
  console.log(`Audio data ready: ${data.byteLength} bytes`);
  await handleTranscription(data);
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
      isAudioWindowReady = false;
      console.error('Audio window renderer exited:', details.reason);
    });

    keyboardHook.start(
      (intent) => startRecording(intent),
      () => stopRecording(),
      () => cachedAgentEnabled
    );

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
    keyboardHook.stop();
    agentSidecar.stop();
    destroyAudioWindow();
  });
}
