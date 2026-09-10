import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

const vi = { fn: mock };

const on = vi.fn();
const once = vi.fn();
const destroy = vi.fn();
const isDestroyed = vi.fn(() => false);
const loadURL = vi.fn();
const loadFile = vi.fn();
const webContentsOn = vi.fn();
const getURL = vi.fn(() => 'http://localhost:5173/#/settings');
const setWindowOpenHandler = vi.fn();
const BrowserWindow = vi.fn(() => ({
  loadURL,
  loadFile,
  on,
  once,
  destroy,
  isDestroyed,
  webContents: {
    on: webContentsOn,
    getURL,
    setWindowOpenHandler,
  },
}));

installElectronMock();

describe('createSingletonWindow', () => {
  beforeEach(() => {
    delete process.env.VITE_DEV_SERVER_URL;
    resetElectronMock();
    electronMock.BrowserWindow.mockImplementation(BrowserWindow);
    BrowserWindow.mockClear();
    loadURL.mockClear();
    loadFile.mockClear();
    on.mockClear();
    once.mockClear();
    destroy.mockClear();
    isDestroyed.mockReturnValue(false);
    webContentsOn.mockClear();
    getURL.mockClear();
    setWindowOpenHandler.mockClear();
  });

  it('creates one BrowserWindow and reuses it while alive', async () => {
    const { createSingletonWindow } = await import(`../window-factory?test=${Date.now()}-1`);
    const windows = createSingletonWindow({
      route: 'audio',
      options: { width: 1, height: 1, show: false },
    });

    const first = windows.create();
    const second = windows.create();

    expect(first).toBe(second);
    expect(windows.get()).toBe(first);
    expect(BrowserWindow).toHaveBeenCalledTimes(1);
    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
      width: 1,
      height: 1,
      show: false,
      webPreferences: expect.objectContaining({
        preload: expect.stringContaining('preload'),
        contextIsolation: true,
        nodeIntegration: false,
      }) as Electron.BrowserWindowConstructorOptions['webPreferences'],
    }));
    expect(loadURL).toHaveBeenCalledWith('http://localhost:5173/#/audio');
  });

  it('loads dev server and packaged routes consistently', async () => {
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:2468/';
    const { createSingletonWindow } = await import(`../window-factory?test=${Date.now()}-2`);
    const windows = createSingletonWindow({
      route: 'settings',
      options: { width: 960, height: 680 },
    });

    windows.create();

    expect(loadURL).toHaveBeenCalledWith('http://localhost:2468/#/settings');

    resetElectronMock();
    electronMock.BrowserWindow.mockImplementation(BrowserWindow);
    electronMock.app.isPackaged = true;
    delete process.env.VITE_DEV_SERVER_URL;
    const packagedWindows = createSingletonWindow({
      route: 'recording?mode=agent',
      options: { width: 118, height: 54 },
    });

    packagedWindows.create();

    expect(loadFile).toHaveBeenCalledWith(expect.stringContaining('renderer'), {
      hash: 'recording?mode=agent',
    });
  });

  it('clears the singleton on close and destroys live windows', async () => {
    const { createSingletonWindow } = await import(`../window-factory?test=${Date.now()}-3`);
    const onClosed = vi.fn();
    const windows = createSingletonWindow({
      route: 'settings',
      options: { width: 960, height: 680 },
      onClosed,
    });

    windows.create();
    const closed = on.mock.calls.find((call: unknown[]) => call[0] === 'closed')?.[1] as () => void;
    closed();

    expect(windows.get()).toBeNull();
    expect(onClosed).toHaveBeenCalled();

    windows.create();
    windows.destroy();

    expect(destroy).toHaveBeenCalled();
    expect(windows.get()).toBeNull();
  });

  it('runs creation hooks after constructing the window', async () => {
    const { createSingletonWindow } = await import(`../window-factory?test=${Date.now()}-4`);
    const onCreated = vi.fn();
    const windows = createSingletonWindow({
      route: 'settings',
      options: { width: 960, height: 680 },
      onCreated,
    });

    const win = windows.create();

    expect(onCreated).toHaveBeenCalledWith(win);
  });

  it('opens external links in the browser instead of navigating app windows', async () => {
    const { createSingletonWindow } = await import(`../window-factory?test=${Date.now()}-5`);
    const windows = createSingletonWindow({
      route: 'settings',
      options: { width: 960, height: 680 },
    });
    windows.create();

    const openHandler = setWindowOpenHandler.mock.calls[0]?.[0] as (details: {
      url: string;
    }) => { action: string };
    expect(openHandler({ url: 'https://github.com/PeeeBrain/shuddhalekhan/pull/1' })).toEqual({
      action: 'deny',
    });
    expect(electronMock.shell.openExternal).toHaveBeenCalledWith(
      'https://github.com/PeeeBrain/shuddhalekhan/pull/1',
    );

    const navigate = webContentsOn.mock.calls.find(
      (call: unknown[]) => call[0] === 'will-navigate',
    )?.[1] as (event: { preventDefault: () => void }, url: string) => void;

    const externalEvent = { preventDefault: vi.fn() };
    navigate(externalEvent, 'https://github.com/PeeeBrain/shuddhalekhan/pull/2');
    expect(externalEvent.preventDefault).toHaveBeenCalled();
    expect(electronMock.shell.openExternal).toHaveBeenCalledWith(
      'https://github.com/PeeeBrain/shuddhalekhan/pull/2',
    );

    const reloadEvent = { preventDefault: vi.fn() };
    navigate(reloadEvent, 'http://localhost:5173/#/settings');
    expect(reloadEvent.preventDefault).not.toHaveBeenCalled();

    const unsafeEvent = { preventDefault: vi.fn() };
    navigate(unsafeEvent, 'javascript:alert(1)');
    expect(unsafeEvent.preventDefault).toHaveBeenCalled();
    expect(electronMock.shell.openExternal).toHaveBeenCalledTimes(2);
  });
});
