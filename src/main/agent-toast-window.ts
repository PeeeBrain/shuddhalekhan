import { app, BrowserWindow, screen } from 'electron';
import { join } from 'path';
import type { AgentToastState } from '../types/ipc';

let toastWindow: BrowserWindow | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: AgentToastState | null = null;
let activeStateKind: AgentToastState['kind'] | null = null;
let lastBounds: Electron.Rectangle | null = null;

const TOAST_WIDTH = 420;
const TOAST_HEIGHT = 190;
const APPROVAL_TOAST_WIDTH = 460;
const APPROVAL_TOAST_HEIGHT = 310;
const TOAST_MARGIN = 24;
const TOAST_MAX_HEIGHT = 520;
const TOAST_RESIZE_STEP = 18;

let streamedContentHeight = TOAST_HEIGHT;

export type ToastWorkArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function showAgentToast(state: AgentToastState): void {
  if (state.kind === 'streaming' && !state.response.trim()) {
    return;
  }

  const win = createAgentToastWindow();
  const previousStateKind = activeStateKind;
  activeStateKind = state.kind;
  const shouldPosition = shouldPositionForState(previousStateKind, state.kind);
  if (shouldPosition) {
    streamedContentHeight = TOAST_HEIGHT;
    positionToastWindow(win, state.kind === 'approval');
  }

  if (win.webContents.isLoading()) {
    pendingState = state;
  } else {
    win.webContents.send('agent-toast:update', state);
  }
  if (!win.isVisible()) {
    win.showInactive();
  }

  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  if (state.kind !== 'approval' && state.kind !== 'streaming') {
    hideTimer = setTimeout(() => {
      if (toastWindow && !toastWindow.isDestroyed()) {
        toastWindow.hide();
      }
    }, state.kind === 'status' ? 3500 : 8500);
  }
}

export function hideAgentToast(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  if (toastWindow && !toastWindow.isDestroyed()) {
    toastWindow.hide();
  }
}

export function handleAgentToastContentSize(contentHeight: number): void {
  if (!toastWindow || toastWindow.isDestroyed()) return;
  if (activeStateKind !== 'streaming' && activeStateKind !== 'completed') return;

  const nextContentHeight = Math.ceil(contentHeight);
  if (activeStateKind === 'streaming' && nextContentHeight <= streamedContentHeight + TOAST_RESIZE_STEP) {
    return;
  }
  if (activeStateKind === 'completed' && nextContentHeight < streamedContentHeight) {
    return;
  }

  streamedContentHeight = Math.max(streamedContentHeight, nextContentHeight);
  const display = screen.getPrimaryDisplay();
  const bounds = calculateToastBounds(display.workArea, {
    isApproval: false,
    contentHeight: streamedContentHeight,
  });
  setToastBounds(toastWindow, bounds);
}

export function calculateToastBounds(
  workArea: ToastWorkArea,
  options: {
    isApproval: boolean;
    contentHeight?: number;
  }
): Electron.Rectangle {
  const toastWidth = options.isApproval ? APPROVAL_TOAST_WIDTH : TOAST_WIDTH;
  const maxHeight = Math.min(TOAST_MAX_HEIGHT, workArea.height - 2 * TOAST_MARGIN);
  const requestedHeight = options.isApproval
    ? APPROVAL_TOAST_HEIGHT
    : Math.max(TOAST_HEIGHT, Math.ceil(options.contentHeight ?? TOAST_HEIGHT));
  const toastHeight = options.isApproval ? APPROVAL_TOAST_HEIGHT : Math.min(requestedHeight, maxHeight);

  return {
    x: workArea.x + workArea.width - toastWidth - TOAST_MARGIN,
    y: workArea.y + workArea.height - toastHeight - TOAST_MARGIN,
    width: toastWidth,
    height: toastHeight,
  };
}

function createAgentToastWindow(): BrowserWindow {
  if (toastWindow && !toastWindow.isDestroyed()) {
    return toastWindow;
  }

  toastWindow = new BrowserWindow({
    width: TOAST_WIDTH,
    height: APPROVAL_TOAST_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  toastWindow.setAlwaysOnTop(true, 'floating');
  toastWindow.webContents.on('did-finish-load', () => {
    if (pendingState && toastWindow && !toastWindow.isDestroyed()) {
      toastWindow.webContents.send('agent-toast:update', pendingState);
      pendingState = null;
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    toastWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/agent-toast`);
  } else if (!app.isPackaged) {
    toastWindow.loadURL('http://localhost:5173/#/agent-toast');
  } else {
    toastWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: 'agent-toast',
    });
  }

  toastWindow.on('closed', () => {
    toastWindow = null;
    pendingState = null;
    activeStateKind = null;
    lastBounds = null;
    streamedContentHeight = TOAST_HEIGHT;
  });

  return toastWindow;
}

function positionToastWindow(win: BrowserWindow, isApproval = false): void {
  const display = screen.getPrimaryDisplay();
  setToastBounds(win, calculateToastBounds(display.workArea, { isApproval }));
}

function setToastBounds(win: BrowserWindow, bounds: Electron.Rectangle): void {
  if (
    lastBounds &&
    lastBounds.x === bounds.x &&
    lastBounds.y === bounds.y &&
    lastBounds.width === bounds.width &&
    lastBounds.height === bounds.height
  ) {
    return;
  }

  win.setBounds(bounds, false);
  lastBounds = bounds;
}

function shouldPositionForState(
  previousStateKind: AgentToastState['kind'] | null,
  nextStateKind: AgentToastState['kind']
): boolean {
  if (nextStateKind === 'streaming') {
    return previousStateKind !== 'streaming' && previousStateKind !== 'completed';
  }

  if (nextStateKind === 'completed') {
    return previousStateKind !== 'streaming' && previousStateKind !== 'completed';
  }

  return true;
}
