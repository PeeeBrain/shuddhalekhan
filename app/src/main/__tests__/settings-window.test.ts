import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';
import {
  createMarkerCollector,
  resetPerformanceMarkerCollectorForTests,
  setPerformanceMarkerCollector,
} from '../performance/marker-collector';

const vi = { fn: mock };

const show = vi.fn();
const focus = vi.fn();
const once = vi.fn();
const on = vi.fn();
const isDestroyed = vi.fn(() => false);
const loadURL = vi.fn();
const loadFile = vi.fn();
const send = vi.fn();
const appIcon = { isEmpty: vi.fn(() => false), resize: vi.fn() };
const BrowserWindow = vi.fn(() => ({
  show,
  focus,
  once,
  on,
  isDestroyed,
  loadURL,
  loadFile,
  webContents: { send },
}));

installElectronMock();

describe('settings window', () => {
  beforeEach(() => {
    delete process.env.VITE_DEV_SERVER_URL;
    resetElectronMock();
    electronMock.nativeImage.createFromPath.mockImplementation(() => appIcon);
    electronMock.nativeImage.createFromDataURL.mockImplementation(() => appIcon);
    electronMock.BrowserWindow.mockImplementation(BrowserWindow);
    BrowserWindow.mockClear();
    show.mockClear();
    focus.mockClear();
    once.mockClear();
    on.mockClear();
    isDestroyed.mockReturnValue(false);
    loadURL.mockClear();
    loadFile.mockClear();
    send.mockClear();
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
      icon: appIcon,
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
    expect(send).toHaveBeenCalledWith('surface:request-paint-proxy', 'settings');
  });

  it('marks cold-create and warm-show requests before opening Settings', async () => {
    const lines: string[] = [];
    setPerformanceMarkerCollector(createMarkerCollector(
      { enabled: true, runId: 'run-1', scenarioId: 'settings-open', eventsPath: 'events.jsonl' },
      { pid: 1, now: () => 10, writeLine: (line) => lines.push(line) },
    ));
    const { openSettingsWindow } = await import(`../settings-window?test=${Date.now()}-markers`);

    openSettingsWindow();
    openSettingsWindow();

    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      { event: 'surface.requested', surface: 'settings', transition: 'cold-create' },
      { event: 'surface.requested', surface: 'settings', transition: 'warm-show' },
    ]);
    resetPerformanceMarkerCollectorForTests();
  });
});
