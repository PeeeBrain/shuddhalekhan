import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

const vi = { fn: mock, mock: mock.module, spyOn };

const ipcHandlers = new Map<string, (...args: any[]) => unknown>();
const ipcListeners = new Map<string, (...args: any[]) => unknown>();
const appListeners = new Map<string, (...args: any[]) => unknown>();
const clipboardText = { value: 'original' };
const send = vi.fn();
const isLoading = vi.fn(() => false);
const isDestroyed = vi.fn(() => false);
const createAudioWindow = vi.fn(() => ({
  webContents: { send, isLoading, on: vi.fn() },
  isDestroyed,
}));
const getAudioWindow = vi.fn(() => ({
  webContents: { send, isLoading },
  isDestroyed,
}));
const destroyAudioWindow = vi.fn();
const showRecordingPill = vi.fn();
const hideRecordingPill = vi.fn();
const getRecordingPillWindow = vi.fn(() => ({
  webContents: { send },
  isDestroyed,
}));
const setConfig = vi.fn();
const getConfig = vi.fn(() => ({
  whisperUrl: 'http://localhost:8080/inference',
  selectedDeviceId: null,
  removeFillerWords: true,
  agent: {
    enabled: false,
    provider: {
      baseUrl: '',
      model: '',
      apiKeyEnvVar: '',
    },
  },
}));
const simulatePaste = vi.fn();
const checkForUpdates = vi.fn();
const getUpdateStatus = vi.fn(() => ({
  state: 'idle',
  currentVersion: '3.1.0',
  message: 'Shuddhalekhan v3.1.0',
  checkedAt: null,
}));
const updateAudioDevices = vi.fn();
const updateUpdaterStatus = vi.fn();
const openSettingsWindow = vi.fn();
const keyboardStart = vi.fn();
const keyboardStop = vi.fn();

installElectronMock();
mock.module('../native/keyboard', () => ({
  keyboardHook: { start: keyboardStart, stop: keyboardStop },
}));
mock.module('../native/clipboard', () => ({ simulatePaste }));
mock.module('../audio-window', () => ({ createAudioWindow, getAudioWindow, destroyAudioWindow }));
mock.module('../recording-pill', () => ({ showRecordingPill, hideRecordingPill, getRecordingPillWindow }));
mock.module('../settings-window', () => ({ openSettingsWindow }));
mock.module('../tray', () => ({ createTray: vi.fn(), updateAudioDevices, updateUpdaterStatus }));
mock.module('../config', () => ({ getConfig, setConfig }));
mock.module('../updater', () => ({ setupUpdater: vi.fn(), checkForUpdates, getUpdateStatus }));

describe('main process IPC orchestration', () => {
  afterAll(() => {
    mock.restore();
  });

  beforeEach(async () => {
    ipcHandlers.clear();
    ipcListeners.clear();
    appListeners.clear();
    clipboardText.value = 'original';
    resetElectronMock();
    electronMock.app.on.mockImplementation((event: string, listener: (...args: any[]) => void) => {
      appListeners.set(event, listener);
    });
    electronMock.BrowserWindow.mockImplementation(() => ({
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      webContents: { send },
    }));
    electronMock.ipcMain.handle.mockImplementation((channel: string, handler: (...args: any[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    });
    electronMock.ipcMain.on.mockImplementation((channel: string, listener: (...args: any[]) => unknown) => {
      ipcListeners.set(channel, listener);
    });
    electronMock.clipboard.readText.mockImplementation(() => clipboardText.value);
    electronMock.clipboard.writeText.mockImplementation((text: string) => {
      clipboardText.value = text;
    });
    send.mockClear();
    isLoading.mockReturnValue(false);
    isDestroyed.mockReturnValue(false);
    createAudioWindow.mockClear();
    getAudioWindow.mockClear();
    destroyAudioWindow.mockClear();
    showRecordingPill.mockClear();
    hideRecordingPill.mockClear();
    setConfig.mockClear();
    getConfig.mockClear();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: 'transcribed text' }),
    })) as unknown as typeof fetch;
    simulatePaste.mockClear();
    checkForUpdates.mockClear();
    getUpdateStatus.mockClear();
    updateAudioDevices.mockClear();
    updateUpdaterStatus.mockClear();
    openSettingsWindow.mockClear();
    keyboardStart.mockClear();
    keyboardStop.mockClear();
    await import(`../index?test=${Date.now()}-${Math.random()}`);
  });

  it('registers the expected IPC handlers and listeners', () => {
    expect([...ipcHandlers.keys()].sort()).toEqual([
      'app:get-info',
      'audio:get-devices',
      'audio:select-device',
      'audio:start-recording',
      'audio:stop-recording',
      'clipboard:inject-text',
      'config:get',
      'config:set',
      'settings:open',
      'updater:check',
      'updater:get-status',
    ]);
    expect([...ipcListeners.keys()].sort()).toEqual([
      'audio-data-ready',
      'audio-devices',
      'audio-duration-changed',
      'audio-level-changed',
      'audio-window-ready',
    ]);
  });

  it('starts recording immediately when the audio window is ready', () => {
    ipcListeners.get('audio-window-ready')?.({});
    ipcHandlers.get('audio:start-recording')?.({});

    expect(createAudioWindow).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('audio:start-recording');
    expect(showRecordingPill).toHaveBeenCalled();
  });

  it('queues start until the hidden audio window reports readiness', () => {
    isLoading.mockReturnValue(true);

    ipcHandlers.get('audio:start-recording')?.({});
    expect(send).not.toHaveBeenCalledWith('audio:start-recording');

    isLoading.mockReturnValue(false);
    ipcListeners.get('audio-window-ready')?.({});
    expect(send).toHaveBeenCalledWith('audio:start-recording');
  });

  it('stops recording and asks the audio window for buffered audio', async () => {
    ipcListeners.get('audio-window-ready')?.({});
    ipcHandlers.get('audio:start-recording')?.({});

    await ipcHandlers.get('audio:stop-recording')?.({});

    expect(hideRecordingPill).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('audio:stop-recording');
  });

  it('transcribes completed audio and restores the clipboard after paste', async () => {
    const listenerPromise = ipcListeners.get('audio-data-ready')?.({}, new Uint8Array(64).buffer) as Promise<void>;
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(simulatePaste).toHaveBeenCalled();
    await listenerPromise;

    expect(fetch).toHaveBeenCalledWith('http://localhost:8080/inference', expect.objectContaining({
      method: 'POST',
      body: expect.any(FormData),
    }));
    expect(electronMock.clipboard.writeText).toHaveBeenNthCalledWith(1, 'transcribed text');
    expect(electronMock.clipboard.writeText).toHaveBeenLastCalledWith('original');
  });

  it('routes agent recordings to the placeholder without injecting text', async () => {
    ipcListeners.get('audio-window-ready')?.({});
    const [onStart] = keyboardStart.mock.calls[0] as [(intent: 'dictation' | 'agent') => void];
    onStart('agent');

    const listenerPromise = ipcListeners.get('audio-data-ready')?.({}, new Uint8Array(64).buffer) as Promise<void>;
    await listenerPromise;

    expect(showRecordingPill).toHaveBeenCalledWith('agent');
    expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Agent Mode',
      detail: 'transcribed text',
    }));
    expect(simulatePaste).not.toHaveBeenCalled();
  });

  it('skips empty WAV payloads', async () => {
    await ipcListeners.get('audio-data-ready')?.({}, new Uint8Array(44).buffer);

    expect(fetch).not.toHaveBeenCalled();
    expect(simulatePaste).not.toHaveBeenCalled();
  });

  it('proxies config, device, update, and recording pill events', async () => {
    expect(ipcHandlers.get('config:get')?.({})).toEqual(getConfig());
    await expect(ipcHandlers.get('app:get-info')?.({})).resolves.toEqual({
      name: 'Shuddhalekhan',
      version: '3.1.0',
      isPackaged: false,
    });
    expect(ipcHandlers.get('updater:get-status')?.({})).toEqual(getUpdateStatus());
    ipcHandlers.get('config:set')?.({}, 'whisperUrl', 'http://new');
    ipcHandlers.get('settings:open')?.({});
    ipcHandlers.get('audio:select-device')?.({}, 'mic-1');
    ipcHandlers.get('updater:check')?.({});
    ipcListeners.get('audio-devices')?.({}, [{ deviceId: 'mic-1', label: 'Mic', kind: 'audioinput' }]);
    ipcListeners.get('audio-level-changed')?.({}, 0.75);
    ipcListeners.get('audio-duration-changed')?.({}, 12);

    expect(setConfig).toHaveBeenCalledWith('whisperUrl', 'http://new');
    expect(openSettingsWindow).toHaveBeenCalled();
    expect(setConfig).toHaveBeenCalledWith('selectedDeviceId', 'mic-1');
    expect(send).toHaveBeenCalledWith('audio:select-device', 'mic-1');
    expect(checkForUpdates).toHaveBeenCalled();
    expect(updateAudioDevices).toHaveBeenCalledWith([{ deviceId: 'mic-1', label: 'Mic', kind: 'audioinput' }]);
    expect(send).toHaveBeenCalledWith('audio:level-changed', 0.75);
    expect(send).toHaveBeenCalledWith('audio:duration-changed', 12);
  });

  it('stops native hooks and destroys the audio window before quit', () => {
    appListeners.get('before-quit')?.();
    appListeners.get('quit')?.();

    expect(keyboardStop).toHaveBeenCalledTimes(2);
    expect(destroyAudioWindow).toHaveBeenCalled();
  });
});
