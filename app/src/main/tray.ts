import { Tray, Menu, app } from 'electron';
import { loadAppIcon } from './app-icon';
import { getConfig, setConfig } from './config';
import type { AudioDevice, UpdateStatus } from '../types/ipc';

let tray: Tray | null = null;
let openSettingsHandler: (() => void) | null = null;
let pasteLastTranscriptHandler: (() => void) | null = null;
let copyLastTranscriptHandler: (() => void) | null = null;
let checkForUpdatesHandler: (() => void) | null = null;
let selectDeviceHandler: ((deviceId: string) => void) | null = null;
let isShortcutsPausedHandler: (() => boolean) | null = null;
let toggleShortcutsPauseHandler: ((paused: boolean) => void) | null = null;
let shortcutsPaused = false;
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
  isShortcutsPaused?: () => boolean;
  onTogglePause?: (paused: boolean) => void;
}

export function createTray(handlers: TrayHandlers): Tray {
  openSettingsHandler = handlers.onOpenSettings;
  pasteLastTranscriptHandler = handlers.onPasteLastTranscript ?? null;
  copyLastTranscriptHandler = handlers.onCopyLastTranscript ?? null;
  checkForUpdatesHandler = handlers.onCheckForUpdates ?? null;
  selectDeviceHandler = handlers.onSelectDevice ?? null;
  isShortcutsPausedHandler = handlers.isShortcutsPaused ?? null;
  toggleShortcutsPauseHandler = handlers.onTogglePause ?? null;
  shortcutsPaused = isShortcutsPausedHandler?.() ?? false;

  const icon = loadAppIcon();
  
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(`Shuddhalekhan v${app.getVersion()}`);
  tray.setIgnoreDoubleClickEvents(true);

  updateTrayMenu();

  return tray;
}

export function updateTrayMenu(): void {
  if (!tray) return;

  const config = getConfig();
  const deviceSubmenu = buildDeviceSubmenu(audioDevices, config.selectedDeviceId);
  const updateStatusLabel = getUpdateStatusLabel(updateStatus);
  // Downloads start automatically and install on exit, so checking only makes sense before or after one.
  const canCheckForUpdates = ['idle', 'checking', 'latest', 'error'].includes(updateStatus.state);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Paste last transcript',
      enabled: !!pasteLastTranscriptHandler,
      click: () => pasteLastTranscriptHandler?.(),
    },
    {
      label: 'Copy last transcript',
      enabled: !!copyLastTranscriptHandler,
      click: () => copyLastTranscriptHandler?.(),
    },
    { type: 'separator' },
    {
      label: 'Microphone',
      submenu: deviceSubmenu,
    },
    {
      label: 'Pause global shortcuts',
      type: 'checkbox',
      checked: shortcutsPaused,
      click: () => {
        toggleShortcutsPauseHandler?.(!shortcutsPaused);
      },
    },
    {
      label: 'Settings…',
      click: () => openSettingsHandler?.(),
    },
    { type: 'separator' },
    {
      label: `Shuddhalekhan v${app.getVersion()}${updateStatusLabel ? ` · ${updateStatusLabel}` : ''}`,
      enabled: false,
    },
    ...(canCheckForUpdates ? [{
      label: updateStatus.state === 'checking' ? 'Checking for updates…' : 'Check for updates',
      enabled: updateStatus.state !== 'checking',
      click: () => checkForUpdatesHandler?.(),
    }] : []),
    { type: 'separator' },
    {
      label: 'Exit',
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

export function updateShortcutPauseState(paused: boolean): void {
  shortcutsPaused = paused;
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

/** Suffix for the version line; empty when there is nothing worth saying. */
function getUpdateStatusLabel(status: UpdateStatus): string {
  switch (status.state) {
    case 'available':
      return `Downloading v${status.availableVersion}`;
    case 'downloading':
      return status.percent === null
        ? `Downloading v${status.availableVersion}`
        : `Downloading v${status.availableVersion} (${status.percent}%)`;
    case 'downloaded':
      return `v${status.availableVersion} installs on exit`;
    case 'latest':
      return 'Up to date';
    case 'error':
      return 'Update check failed';
    case 'idle':
    case 'checking':
      return '';
  }
}

export function getTray(): Tray | null {
  return tray;
}

