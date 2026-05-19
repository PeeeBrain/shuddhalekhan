import { app, BrowserWindow } from 'electron';
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
      autoHideMenuBar: true,
      ...config.options,
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        ...config.options.webPreferences,
      },
    });
    window.setMenu?.(null);
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

function loadRendererRoute(window: BrowserWindow, route: string): void {
  if (process.env.VITE_DEV_SERVER_URL) {
    window.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/${route}`);
  } else if (!app.isPackaged) {
    window.loadURL(`http://localhost:5173/#/${route}`);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), { hash: route });
  }
}
