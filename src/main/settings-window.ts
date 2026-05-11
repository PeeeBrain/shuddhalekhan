import type { BrowserWindow } from 'electron';
import { createSingletonWindow } from './window-factory';

const settingsWindow = createSingletonWindow({
  route: 'settings',
  options: {
    width: 960,
    height: 680,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Shuddhalekhan Settings',
    backgroundColor: '#0f1115',
  },
  onCreated: (window) => {
    window.once('ready-to-show', () => {
      settingsWindow.get()?.show();
    });
  },
});

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow.get();
}

export function openSettingsWindow(): BrowserWindow {
  const existingWindow = settingsWindow.get();
  if (existingWindow && !existingWindow.isDestroyed()) {
    existingWindow.show();
    existingWindow.focus();
    return existingWindow;
  }

  return settingsWindow.create();
}
