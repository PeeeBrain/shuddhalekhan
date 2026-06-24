import { Tray, Menu, nativeImage, app } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';
import { getConfig, setConfig } from './config';
import type { AudioDevice, UpdateStatus } from '../types/ipc';

let tray: Tray | null = null;
let openSettingsHandler: (() => void) | null = null;
let pasteLastTranscriptHandler: (() => void) | null = null;
let copyLastTranscriptHandler: (() => void) | null = null;
let checkForUpdatesHandler: (() => void) | null = null;
let selectDeviceHandler: ((deviceId: string) => void) | null = null;
let audioDevices: AudioDevice[] = [];
let updateStatus: UpdateStatus = {
  state: 'idle',
  currentVersion: app.getVersion(),
  message: `Shuddhalekhan v${app.getVersion()}`,
  checkedAt: null,
};

export interface TrayHandlers {
  onOpenSettings: () => void;
  onPasteLastTranscript?: () => void;
  onCopyLastTranscript?: () => void;
  onCheckForUpdates?: () => void;
  onSelectDevice?: (deviceId: string) => void;
}

export function createTray(handlers: TrayHandlers): Tray {
  openSettingsHandler = handlers.onOpenSettings;
  pasteLastTranscriptHandler = handlers.onPasteLastTranscript ?? null;
  copyLastTranscriptHandler = handlers.onCopyLastTranscript ?? null;
  checkForUpdatesHandler = handlers.onCheckForUpdates ?? null;
  selectDeviceHandler = handlers.onSelectDevice ?? null;

  const icon = loadTrayIcon();
  
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(`Shuddhalekhan v${app.getVersion()}`);
  tray.setIgnoreDoubleClickEvents(true);

  updateTrayMenu();

  tray.on('click', () => {
    // Optional: show main window on click
  });

  return tray;
}

export function updateTrayMenu(): void {
  if (!tray) return;

  const config = getConfig();
  const deviceSubmenu = buildDeviceSubmenu(audioDevices, config.selectedDeviceId);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Shuddhalekhan v${app.getVersion()}`,
      enabled: false,
    },
    {
      label: getUpdateMenuLabel(updateStatus),
      enabled: false,
    },
    {
      label: updateStatus.state === 'checking' ? 'Checking...' : 'Check for Updates',
      enabled: updateStatus.state !== 'checking',
      click: () => checkForUpdatesHandler?.(),
    },
    { type: 'separator' },
    {
      label: 'Audio Devices',
      submenu: deviceSubmenu,
    },
    { type: 'separator' },
    {
      label: `Agent Mode: ${config.agent.enabled ? 'Enabled' : 'Disabled'}`,
      enabled: false,
    },
    {
      label: 'Settings...',
      click: () => openSettingsHandler?.(),
    },
    { type: 'separator' },
    {
      label: 'Paste Last Transcript',
      enabled: !!pasteLastTranscriptHandler,
      click: () => pasteLastTranscriptHandler?.(),
    },
    {
      label: 'Copy Last Transcript',
      enabled: !!copyLastTranscriptHandler,
      click: () => copyLastTranscriptHandler?.(),
    },
    { type: 'separator' },
    {
      label: 'Exit',
      accelerator: 'CommandOrControl+Q',
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);
}

export function updateAudioDevices(devices: AudioDevice[]): void {
  audioDevices = devices.filter((device) => device.kind === 'audioinput');
  updateTrayMenu();
}

export function updateUpdaterStatus(status: UpdateStatus): void {
  updateStatus = status;
  updateTrayMenu();
}

function buildDeviceSubmenu(
  devices: AudioDevice[],
  currentDeviceId: string | null
): Electron.MenuItemConstructorOptions[] {
  const deviceSubmenu: Electron.MenuItemConstructorOptions[] = devices.map((device) => ({
    label: device.label || `Device ${device.deviceId.slice(0, 8)}`,
    type: 'radio',
    checked: device.deviceId === currentDeviceId || (!currentDeviceId && device.deviceId === 'default'),
    click: () => {
      setConfig('selectedDeviceId', device.deviceId);
      selectDeviceHandler?.(device.deviceId);
      updateTrayMenu();
    },
  }));

  if (deviceSubmenu.length === 0) {
    deviceSubmenu.push({ label: 'No audio devices found', enabled: false });
  }

  return deviceSubmenu;
}

function getUpdateMenuLabel(status: UpdateStatus): string {
  switch (status.state) {
    case 'checking':
      return 'Update status: checking...';
    case 'available':
      return `Update status: v${status.availableVersion} available`;
    case 'downloading':
      return status.percent === null
        ? `Update status: downloading v${status.availableVersion}`
        : `Update status: downloading v${status.availableVersion} (${status.percent}%)`;
    case 'downloaded':
      return `Update status: v${status.availableVersion} ready to install`;
    case 'latest':
      return `Update status: latest (${status.latestVersion})`;
    case 'error':
      return 'Update status: check failed';
    case 'idle':
      return 'Update status: not checked yet';
  }
}

export function getTray(): Tray | null {
  return tray;
}

function loadTrayIcon(): Electron.NativeImage {
  const candidatePaths = app.isPackaged
    ? [
        join(process.resourcesPath, 'icons', 'tray-icon.ico'),
        join(app.getAppPath(), 'icons', 'tray-icon.ico'),
      ]
    : [
        join(app.getAppPath(), 'icons', 'tray-icon.ico'),
      ];

  for (const iconPath of candidatePaths) {
    if (!existsSync(iconPath)) continue;

    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      return icon;
    }
  }

  return nativeImage.createFromDataURL(
    'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
          <rect width="32" height="32" rx="8" fill="#141417"/>
          <path d="M10 16h12" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
          <path d="M16 8v16" stroke="#646cff" stroke-width="3" stroke-linecap="round"/>
        </svg>
      `)
  );
}
