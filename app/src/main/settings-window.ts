import type { BrowserWindow } from 'electron';
import { createSingletonWindow } from './window-factory';

let closedHandler: (() => void) | null = null;

/** Register teardown work (e.g. ending shortcut capture) for window close. */
export function setSettingsWindowClosedHandler(handler: (() => void) | null): void {
  closedHandler = handler;
}

const settingsWindow = createSingletonWindow({
  route: 'settings',
  options: {
    width: 1040,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    resizable: true,
    show: false,
    title: 'Shuddhalekhan Settings',
    backgroundColor: '#0f1115',
  },
  onCreated: (window) => {
    window.once('ready-to-show', () => {
      settingsWindow.get()?.show();
    });
  },
  onClosed: () => {
    closedHandler?.();
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
