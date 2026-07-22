import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

const vi = { fn: mock };

const show = vi.fn();
const focus = vi.fn();
const once = vi.fn();
const on = vi.fn();
const isDestroyed = vi.fn(() => false);
const loadURL = vi.fn();
const loadFile = vi.fn();
const BrowserWindow = vi.fn(() => ({
  show,
  focus,
  once,
  on,
  isDestroyed,
  loadURL,
  loadFile,
}));

installElectronMock();

describe('settings window', () => {
  beforeEach(() => {
    delete process.env.VITE_DEV_SERVER_URL;
    resetElectronMock();
    electronMock.BrowserWindow.mockImplementation(BrowserWindow);
    BrowserWindow.mockClear();
    show.mockClear();
    focus.mockClear();
    once.mockClear();
    on.mockClear();
    isDestroyed.mockReturnValue(false);
    loadURL.mockClear();
    loadFile.mockClear();
  });

  it('creates the settings window hidden and shows it when ready', async () => {
    const { openSettingsWindow } = await import(`../settings-window?test=${Date.now()}-1`);

    openSettingsWindow();
    const readyToShow = once.mock.calls.find((call: unknown[]) => call[0] === 'ready-to-show')?.[1] as () => void;
    readyToShow();

    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
      width: 1040,
      height: 720,
      minWidth: 820,
      minHeight: 560,
      resizable: true,
      show: false,
      title: 'Shuddhalekhan Settings',
      backgroundColor: '#0f1115',
    }));
    expect(loadURL).toHaveBeenCalledWith('http://localhost:5173/#/settings');
    expect(show).toHaveBeenCalled();
  });

  it('focuses the existing settings window instead of creating another one', async () => {
    const { openSettingsWindow } = await import(`../settings-window?test=${Date.now()}-2`);

    const first = openSettingsWindow();
    const second = openSettingsWindow();

    expect(second).toBe(first);
    expect(BrowserWindow).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
