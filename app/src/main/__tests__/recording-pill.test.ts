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
const isVisible = vi.fn(() => false);
const show = vi.fn();
const setAlwaysOnTop = vi.fn();
const send = vi.fn();
const isLoading = vi.fn(() => false);
const once = vi.fn();
const webContentsOnce = vi.fn();
const hide = vi.fn();
const BrowserWindow = vi.fn(() => ({
  loadURL,
  on,
  isDestroyed,
  isVisible,
  show,
  hide,
  setAlwaysOnTop,
  setPosition: vi.fn(),
  webContents: { send, isLoading, once: webContentsOnce },
  once,
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
    isVisible.mockReturnValue(false);
    show.mockClear();
    setAlwaysOnTop.mockClear();
    send.mockClear();
    isLoading.mockClear();
    once.mockClear();
    webContentsOnce.mockClear();
    isLoading.mockReturnValue(false);
    hide.mockClear();
    once._pendingHandler = undefined;
    once._pendingEvent = undefined;
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

  it('prewarms the recording renderer while keeping the pill hidden', async () => {
    const { prepareRecordingPillWindow } = await import(`../recording-pill?test=${Date.now()}-prewarm`);

    prepareRecordingPillWindow();

    expect(BrowserWindow).toHaveBeenCalledTimes(1);
    expect(loadURL).toHaveBeenCalledWith('http://localhost:5173/#/recording?mode=dictation');
    expect(show).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith('recording:pill-show');
  });

  it('shows a prewarmed renderer immediately on first recording after it finishes loading', async () => {
    const { prepareRecordingPillWindow, showRecordingPill } = await import(`../recording-pill?test=${Date.now()}-prewarm-ready`);

    isLoading.mockReturnValue(true);
    prepareRecordingPillWindow();
    isLoading.mockReturnValue(false);
    showRecordingPill('agent');

    expect(BrowserWindow).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('recording:pill-show');
    expect(send).toHaveBeenCalledWith('recording:mode-changed', 'agent');
    expect(once).not.toHaveBeenCalledWith('ready-to-show', expect.any(Function));
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

  it('defers showing the window and pill events until the renderer is ready to show (so React listeners exist)', async () => {
    isLoading.mockReturnValue(true);
    once.mockImplementation((event: string, handler: () => void) => {
      once._pendingHandler = handler;
      once._pendingEvent = event;
    });

    const { showRecordingPill } = await import(`../recording-pill?test=${Date.now()}-4`);

    showRecordingPill('dictation');

    expect(once).toHaveBeenCalledWith('ready-to-show', expect.any(Function));
    expect(show).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith('recording:pill-show');

    once._pendingHandler?.();

    expect(show).toHaveBeenCalled();
    expect(setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
    expect(send).toHaveBeenCalledWith('recording:pill-show');
    expect(send).toHaveBeenCalledWith('recording:mode-changed', 'dictation');
  });

  it('shows the window and sends pill events immediately when the renderer is already ready', async () => {
    isLoading.mockReturnValue(false);
    isVisible.mockReturnValue(false);

    const { showRecordingPill } = await import(`../recording-pill?test=${Date.now()}-ready2`);

    showRecordingPill('dictation');

    expect(show).toHaveBeenCalled();
    expect(setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
    expect(send).toHaveBeenCalledWith('recording:pill-show');
    expect(send).toHaveBeenCalledWith('recording:mode-changed', 'dictation');
    expect(once).not.toHaveBeenCalledWith('ready-to-show', expect.any(Function));
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
