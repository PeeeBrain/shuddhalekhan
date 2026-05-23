import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

const vi = { fn: mock, mock: mock.module, spyOn };

const screen = {
  getPrimaryDisplay: vi.fn(() => ({
    workAreaSize: { width: 1920, height: 1040 },
    workArea: { x: 0, y: 0 },
  })),
};
const loadURL = vi.fn();
const on = vi.fn();
const isDestroyed = vi.fn(() => false);
const show = vi.fn();
const setAlwaysOnTop = vi.fn();
const send = vi.fn();
const BrowserWindow = vi.fn(() => ({
  loadURL,
  on,
  isDestroyed,
  show,
  setAlwaysOnTop,
  setPosition: vi.fn(),
  webContents: { send },
}));

installElectronMock();

describe('positionPillWindow', () => {
  beforeEach(() => {
    resetElectronMock();
    electronMock.screen.getPrimaryDisplay.mockImplementation(screen.getPrimaryDisplay);
    electronMock.BrowserWindow.mockImplementation(BrowserWindow);
    screen.getPrimaryDisplay.mockReturnValue({
      workAreaSize: { width: 1920, height: 1040 },
      workArea: { x: 0, y: 0 },
    });
    BrowserWindow.mockClear();
    loadURL.mockClear();
    on.mockClear();
    isDestroyed.mockReturnValue(false);
    show.mockClear();
    setAlwaysOnTop.mockClear();
    send.mockClear();
  });

  it('centers the recording pill near the bottom of the primary display', async () => {
    const { positionPillWindow } = await import(`../recording-pill?test=${Date.now()}-1`);
    const setPosition = vi.fn();

    positionPillWindow({ setPosition });

    expect(setPosition).toHaveBeenCalledWith(908, 946);
  });

  it('accounts for displays whose work area is offset', async () => {
    screen.getPrimaryDisplay.mockReturnValue({
      workAreaSize: { width: 1280, height: 720 },
      workArea: { x: 1920, y: 40 },
    });
    const { positionPillWindow } = await import(`../recording-pill?test=${Date.now()}-2`);
    const setPosition = vi.fn();

    positionPillWindow({ setPosition });

    expect(setPosition).toHaveBeenCalledWith(2508, 666);
  });

  it('creates the recording pill for the active intent and reuses it while alive', async () => {
    const { createRecordingPillWindow, showRecordingPill } = await import(`../recording-pill?test=${Date.now()}-3`);

    const first = createRecordingPillWindow('agent');
    const second = createRecordingPillWindow('dictation');
    showRecordingPill('agent');

    expect(first).toBe(second);
    expect(BrowserWindow).toHaveBeenCalledTimes(1);
    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
      width: 104,
      height: 46,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
    }));
    expect(loadURL).toHaveBeenCalledWith('http://localhost:5173/#/recording?mode=agent');
    expect(show).toHaveBeenCalled();
    expect(setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
    expect(send).toHaveBeenCalledWith('recording:mode-changed', 'agent');
  });
});
