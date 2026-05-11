import type { BrowserWindow } from 'electron';
import { createSingletonWindow } from './window-factory';

const audioWindow = createSingletonWindow({
  route: 'audio',
  options: {
    width: 1,
    height: 1,
    show: false,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      backgroundThrottling: false,
    },
  },
});

export function getAudioWindow(): BrowserWindow | null {
  return audioWindow.get();
}

export function createAudioWindow(): BrowserWindow {
  return audioWindow.create();
}

export function destroyAudioWindow(): void {
  audioWindow.destroy();
}
