import { app, BrowserWindow } from 'electron';
import { join } from 'path';

let settingsWindow: BrowserWindow | null = null;

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow;
}

export function openSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Shuddhalekhan Settings',
    backgroundColor: '#101214',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    settingsWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/settings`);
  } else if (!app.isPackaged) {
    settingsWindow.loadURL('http://localhost:5173/#/settings');
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: 'settings',
    });
  }

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  return settingsWindow;
}
