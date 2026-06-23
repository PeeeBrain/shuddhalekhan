import { screen } from 'electron';
import type { BrowserWindow } from 'electron';
import type { RecordingIntent } from '../types/ipc';
import { createSingletonWindow } from './window-factory';

const PILL_WINDOW_WIDTH = 140;
const PILL_WINDOW_HEIGHT = 52;
let initialIntent: RecordingIntent = 'dictation';

const pillWindow = createSingletonWindow({
  route: () => `recording?mode=${initialIntent}`,
  options: {
    width: PILL_WINDOW_WIDTH,
    height: PILL_WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
  },
});

export function getRecordingPillWindow(): BrowserWindow | null {
  return pillWindow.get();
}

export function createRecordingPillWindow(intent: RecordingIntent = 'dictation'): BrowserWindow {
  initialIntent = intent;
  return pillWindow.create();
}

export function showRecordingPill(intent: RecordingIntent = 'dictation'): void {
  const win = createRecordingPillWindow(intent);
  positionPillWindow(win);
  win.show();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.send('recording:pill-show');
  win.webContents.send('recording:mode-changed', intent);
}

export function hideRecordingPill(): void {
  const win = pillWindow.get();
  if (win && !win.isDestroyed()) {
    win.webContents.send('recording:pill-hide');
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.hide();
      }
    }, 100);
  }
}

export function positionPillWindow(window: Pick<BrowserWindow, 'setPosition'>): void {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const { x, y } = primaryDisplay.workArea;

  const bottomMargin = 48;

  const posX = x + Math.max(0, (width - PILL_WINDOW_WIDTH) / 2);
  const posY = y + Math.max(0, height - PILL_WINDOW_HEIGHT - bottomMargin);

  window.setPosition(Math.round(posX), Math.round(posY));
}
