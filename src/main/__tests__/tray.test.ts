import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { normalize } from 'path';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

const vi = { fn: mock, mock: mock.module, spyOn };

const setContextMenu = vi.fn();
const setToolTip = vi.fn();
const setIgnoreDoubleClickEvents = vi.fn();
const trayOn = vi.fn();
const resize = vi.fn(() => ({ resized: true }));
const createFromPath = vi.fn(() => ({ isEmpty: () => false, resize }));
const createFromDataURL = vi.fn(() => ({ fallback: true, resize }));
const buildFromTemplate = vi.fn((template: unknown) => template);
const quit = vi.fn();
const existsSync = vi.fn(() => true);
const config = {
  whisperUrl: 'http://localhost:8080/inference',
  selectedDeviceId: null as string | null,
  removeFillerWords: true,
  agent: {
    enabled: false,
    provider: {
      baseUrl: '',
      model: '',
      apiKeyEnvVar: '',
      thinkingEnabled: true,
    },
  },
};
const setConfig = vi.fn((key: keyof typeof config, value: never) => {
  config[key] = value;
});
const send = vi.fn();
let audioWindow: { isDestroyed: () => boolean; webContents: { send: typeof send } } | null = null;

installElectronMock();
mock.module('fs', () => ({ existsSync }));
mock.module('../config', () => ({
  getConfig: () => config,
  setConfig,
}));
mock.module('../audio-window', () => ({
  getAudioWindow: () => audioWindow,
}));

describe('tray', () => {
  beforeEach(() => {
    resetElectronMock();
    electronMock.Tray.mockImplementation(() => ({
      setToolTip,
      setIgnoreDoubleClickEvents,
      setContextMenu,
      on: trayOn,
    }));
    electronMock.Menu.buildFromTemplate.mockImplementation(buildFromTemplate);
    electronMock.nativeImage.createFromPath.mockImplementation(createFromPath);
    electronMock.nativeImage.createFromDataURL.mockImplementation(createFromDataURL);
    electronMock.app.quit.mockImplementation(quit);
    setContextMenu.mockClear();
    setToolTip.mockClear();
    setIgnoreDoubleClickEvents.mockClear();
    trayOn.mockClear();
    resize.mockClear();
    createFromPath.mockClear();
    createFromDataURL.mockClear();
    buildFromTemplate.mockClear();
    quit.mockClear();
    setConfig.mockClear();
    send.mockClear();
    existsSync.mockReturnValue(true);
    config.selectedDeviceId = null;
    config.removeFillerWords = true;
    audioWindow = null;
  });

  it('creates a tray with tooltip, icon, and context menu', async () => {
    const { createTray } = await import(`../tray?test=${Date.now()}-1`);

    createTray({ onOpenSettings: vi.fn() });

    expect(createFromPath).toHaveBeenCalledWith(normalize('/app/icons/tray-icon.ico'));
    expect(resize).toHaveBeenCalledWith({ width: 16, height: 16 });
    expect(setToolTip).toHaveBeenCalledWith('Shuddhalekhan v4.0.0');
    expect(setIgnoreDoubleClickEvents).toHaveBeenCalledWith(true);
    expect(setContextMenu).toHaveBeenCalled();
  });

  it('falls back to an embedded icon when the file icon is missing', async () => {
    existsSync.mockReturnValue(false);
    const { createTray } = await import(`../tray?test=${Date.now()}-2`);

    createTray({ onOpenSettings: vi.fn() });

    expect(createFromDataURL).toHaveBeenCalledWith(expect.stringContaining('data:image/svg+xml'));
  });

  it('loads the packaged tray icon from extra resources before app bundle fallback', async () => {
    electronMock.app.isPackaged = true;
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: normalize('/resources'),
    });
    const { createTray } = await import(`../tray?test=${Date.now()}-packaged`);

    createTray({ onOpenSettings: vi.fn() });

    expect(createFromPath).toHaveBeenCalledWith(normalize('/resources/icons/tray-icon.ico'));
  });

  it('filters audio inputs and sends device selections to the audio window', async () => {
    audioWindow = { isDestroyed: () => false, webContents: { send } };
    const { createTray, updateAudioDevices } = await import(`../tray?test=${Date.now()}-3`);
    createTray({ onOpenSettings: vi.fn() });

    updateAudioDevices([
      { deviceId: 'default', label: 'Default Mic', kind: 'audioinput' },
      { deviceId: 'speaker', label: 'Speaker', kind: 'audioinput' },
    ]);
    const latestMenu = buildFromTemplate.mock.calls.at(-1)?.[0];
    const deviceItems = latestMenu[4].submenu;

    expect(deviceItems).toHaveLength(2);
    expect(deviceItems[0].checked).toBe(true);
    deviceItems[1].click();

    expect(setConfig).toHaveBeenCalledWith('selectedDeviceId', 'speaker');
    expect(send).toHaveBeenCalledWith('audio:select-device', 'speaker');
  });

  it('keeps settings-owned actions out of the tray and handles exit', async () => {
    const { createTray } = await import(`../tray?test=${Date.now()}-4`);

    createTray({ onOpenSettings: vi.fn() });
    const menu = buildFromTemplate.mock.calls.at(-1)?.[0];

    expect(menu.some((item: { label?: string }) => item.label === 'Clean Transcription')).toBe(false);
    menu[12].click();

    expect(quit).toHaveBeenCalled();
  });

  it('opens settings from the tray and shows agent status', async () => {
    const settingsHandler = vi.fn();
    const { createTray } = await import(`../tray?test=${Date.now()}-settings`);

    createTray({ onOpenSettings: settingsHandler });
    const menu = buildFromTemplate.mock.calls.at(-1)?.[0];

    expect(menu[6].label).toBe('Agent Mode: Disabled');
    menu[7].click();
    expect(settingsHandler).toHaveBeenCalled();
  });

  it('shows update status in the tray menu', async () => {
    const { createTray, updateUpdaterStatus } = await import(`../tray?test=${Date.now()}-5`);

    createTray({ onOpenSettings: vi.fn() });
    updateUpdaterStatus({
      state: 'latest',
      currentVersion: '4.0.0',
      latestVersion: '4.0.0',
      message: "You're on the latest version: Shuddhalekhan v4.0.0.",
      checkedAt: new Date().toISOString(),
    });
    const menu = buildFromTemplate.mock.calls.at(-1)?.[0];

    expect(menu[0].label).toBe('Shuddhalekhan v4.0.0');
    expect(menu[1].label).toBe('Update status: latest (4.0.0)');
  });

  it('shows Check for Updates menu item that triggers the check handler', async () => {
    const checkHandler = vi.fn();
    const { createTray } = await import(`../tray?test=${Date.now()}-check-updates`);

    createTray({ onOpenSettings: vi.fn(), onCheckForUpdates: checkHandler });
    const menu = buildFromTemplate.mock.calls.at(-1)?.[0];

    expect(menu[2].label).toBe('Check for Updates');
    expect(menu[2].enabled).toBe(true);
    menu[2].click();
    expect(checkHandler).toHaveBeenCalled();
  });

  it('disables Check for Updates item while checking', async () => {
    const { createTray, updateUpdaterStatus } = await import(`../tray?test=${Date.now()}-checking-state`);

    createTray({ onOpenSettings: vi.fn() });
    updateUpdaterStatus({
      state: 'checking',
      currentVersion: '4.0.0',
      message: 'Checking for updates...',
      checkedAt: null,
    });
    const menu = buildFromTemplate.mock.calls.at(-1)?.[0];

    expect(menu[2].label).toBe('Checking...');
    expect(menu[2].enabled).toBe(false);
  });

  it('exposes paste and copy last transcript actions when handlers are provided', async () => {
    const pasteHandler = vi.fn();
    const copyHandler = vi.fn();
    const { createTray } = await import(`../tray?test=${Date.now()}-recovery`);

    createTray({ onOpenSettings: vi.fn(), onPasteLastTranscript: pasteHandler, onCopyLastTranscript: copyHandler });
    const menu = buildFromTemplate.mock.calls.at(-1)?.[0];

    expect(menu[9].label).toBe('Paste Last Transcript');
    expect(menu[9].enabled).toBe(true);
    menu[9].click();
    expect(pasteHandler).toHaveBeenCalled();

    expect(menu[10].label).toBe('Copy Last Transcript');
    expect(menu[10].enabled).toBe(true);
    menu[10].click();
    expect(copyHandler).toHaveBeenCalled();
  });

  it('disables recovery actions when no handlers are provided', async () => {
    const { createTray } = await import(`../tray?test=${Date.now()}-no-recovery`);

    createTray({ onOpenSettings: vi.fn() });
    const menu = buildFromTemplate.mock.calls.at(-1)?.[0];

    expect(menu[9].label).toBe('Paste Last Transcript');
    expect(menu[9].enabled).toBe(false);
    expect(menu[10].label).toBe('Copy Last Transcript');
    expect(menu[10].enabled).toBe(false);
  });
});
