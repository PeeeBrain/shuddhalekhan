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
const isLoading = vi.fn(() => false);
const once = vi.fn();
const hide = vi.fn();
const BrowserWindow = vi.fn(() => ({
  loadURL,
  on,
  isDestroyed,
  show,
  hide,
  setAlwaysOnTop,
  setPosition: vi.fn(),
  webContents: { send, isLoading, once },
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
    isLoading.mockClear();
    once.mockClear();
    isLoading.mockReturnValue(false);
    hide.mockClear();
  });

  it('centers the recording pill near the bottom of the primary display', async () => {
    const { positionPillWindow } = await import(`../recording-pill?test=${Date.now()}-1`);
    const setPosition = vi.fn();

    positionPillWindow({ setPosition });

    expect(setPosition).toHaveBeenCalledWith(874, 940);
  });

  it('accounts for displays whose work area is offset', async () => {
    screen.getPrimaryDisplay.mockReturnValue({
      workAreaSize: { width: 1280, height: 720 },
      workArea: { x: 1920, y: 40 },
    });
    const { positionPillWindow } = await import(`../recording-pill?test=${Date.now()}-2`);
    const setPosition = vi.fn();

    positionPillWindow({ setPosition });

    expect(setPosition).toHaveBeenCalledWith(2474, 660);
  });

  it('creates the recording pill for the active intent and reuses it while alive', async () => {
    const { createRecordingPillWindow, showRecordingPill } = await import(`../recording-pill?test=${Date.now()}-3`);

    const first = createRecordingPillWindow('agent');
    const second = createRecordingPillWindow('dictation');
    showRecordingPill('agent');

    expect(first).toBe(second);
    expect(BrowserWindow).toHaveBeenCalledTimes(1);
    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
      width: 172,
      height: 52,
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

  it('defers pill-show IPC events until the renderer finishes loading', async () => {
    isLoading.mockReturnValue(true);
    once.mockImplementation((event: string, handler: () => void) => {
      once._pendingHandler = handler;
      once._pendingEvent = event;
    });

    const { showRecordingPill } = await import(`../recording-pill?test=${Date.now()}-4`);

    showRecordingPill('dictation');

    expect(once).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
    expect(send).not.toHaveBeenCalledWith('recording:pill-show');

    once._pendingHandler?.();

    expect(send).toHaveBeenCalledWith('recording:pill-show');
    expect(send).toHaveBeenCalledWith('recording:mode-changed', 'dictation');
  });

  it('cancels a pending hide timeout when showRecordingPill is called again', async () => {
    const { showRecordingPill, hideRecordingPill } = await import(`../recording-pill?test=${Date.now()}-5`);

    showRecordingPill('dictation');
    hide.mockClear();
    send.mockClear();

    hideRecordingPill();
    showRecordingPill('agent');

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(hide).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('recording:pill-show');
  });
});
