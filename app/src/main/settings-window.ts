import type { BrowserWindow } from 'electron';
import { createSingletonWindow } from './window-factory';
import { loadAppIcon } from './app-icon';

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
    icon: loadAppIcon(),
    backgroundColor: '#0f1115',
    // The default File/Edit/View menu clashes with the custom UI; Alt still reveals it.
    autoHideMenuBar: true,
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

export function openSettingsWindow(section?: 'about'): BrowserWindow {
  const existingWindow = settingsWindow.get();
  if (existingWindow && !existingWindow.isDestroyed()) {
    existingWindow.show();
    existingWindow.focus();
    if (section) {
      existingWindow.webContents.send('settings:navigate', section);
    }
    return existingWindow;
  }

  const createdWindow = settingsWindow.create();
  if (section) {
    createdWindow.webContents.once('did-finish-load', () => {
      createdWindow.webContents.send('settings:navigate', section);
    });
  }
  return createdWindow;
}
