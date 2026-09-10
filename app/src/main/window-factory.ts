import { app, BrowserWindow, shell } from 'electron';
import { join } from 'path';

export interface SingletonWindowController {
  get: () => BrowserWindow | null;
  create: () => BrowserWindow;
  destroy: () => void;
}

interface SingletonWindowConfig {
  route: string | (() => string);
  options: Electron.BrowserWindowConstructorOptions;
  onCreated?: (window: BrowserWindow) => void;
  onClosed?: () => void;
}

export function createSingletonWindow(config: SingletonWindowConfig): SingletonWindowController {
  let window: BrowserWindow | null = null;

  function get(): BrowserWindow | null {
    return window;
  }

  function create(): BrowserWindow {
    if (window && !window.isDestroyed()) {
      return window;
    }

    window = new BrowserWindow({
      ...config.options,
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        ...config.options.webPreferences,
      },
    });
    installExternalLinkHandling(window);
    config.onCreated?.(window);
    loadRendererRoute(window, resolveRoute(config.route));
    window.on('closed', () => {
      window = null;
      config.onClosed?.();
    });

    return window;
  }

  function destroy(): void {
    if (window && !window.isDestroyed()) {
      window.destroy();
      window = null;
    }
  }

  return { get, create, destroy };
}

function resolveRoute(route: string | (() => string)): string {
  return typeof route === 'function' ? route() : route;
}

/** App surfaces never navigate away from their route; links open in the browser. */
function installExternalLinkHandling(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return;
    event.preventDefault();
    openExternalUrl(url);
  });
}

function openExternalUrl(url: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return;
  }

  if (protocol !== 'https:' && protocol !== 'http:') return;
  void shell.openExternal(url);
}

function loadRendererRoute(window: BrowserWindow, route: string): void {
  if (process.env.VITE_DEV_SERVER_URL) {
    window.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/${route}`);
  } else if (!app.isPackaged) {
    window.loadURL(`http://localhost:5173/#/${route}`);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), { hash: route });
  }
}
