import { screen } from 'electron';
import type { BrowserWindow } from 'electron';
import type { RecordingIntent } from '../types/ipc';
import { createSingletonWindow } from './window-factory';

const PILL_WINDOW_WIDTH = 172;
const PILL_WINDOW_HEIGHT = 52;
let initialIntent: RecordingIntent = 'dictation';
let pendingHideTimeout: ReturnType<typeof setTimeout> | null = null;

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
  if (pendingHideTimeout) {
    clearTimeout(pendingHideTimeout);
    pendingHideTimeout = null;
  }

  const win = createRecordingPillWindow(intent);
  positionPillWindow(win);

  const sendEvents = () => {
    if (win.isDestroyed()) return;
    win.webContents.send('recording:pill-show');
    win.webContents.send('recording:mode-changed', intent);
  };

  const showAndSend = () => {
    if (win.isDestroyed()) return;
    if (!win.isVisible()) {
      win.show();
      win.setAlwaysOnTop(true, 'screen-saver');
    }
    sendEvents();
  };

  if (win.isVisible()) {
    sendEvents();
  } else if (win.webContents.isLoading()) {
    win.once('ready-to-show', showAndSend);
  } else {
    showAndSend();
  }
}

export function updateRecordingDurationWarning(remainingSeconds: number | null): void {
  const win = pillWindow.get();
  if (win && !win.isDestroyed()) {
    win.webContents.send('recording:duration-warning', remainingSeconds);
  }
}

export function hideRecordingPill(): void {
  const win = pillWindow.get();
  if (win && !win.isDestroyed()) {
    win.webContents.send('recording:pill-hide');
    pendingHideTimeout = setTimeout(() => {
      if (!win.isDestroyed()) {
        win.hide();
      }
      pendingHideTimeout = null;
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
