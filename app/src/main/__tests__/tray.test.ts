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

type MenuItemSpec = {
  label?: string;
  submenu?: MenuItemSpec[];
  click?: () => void;
  checked?: boolean;
  enabled?: boolean;
  type?: string;
};

const menuAt = (): MenuItemSpec[] => (buildFromTemplate.mock.calls.at(-1)?.[0] ?? []) as MenuItemSpec[];
const item = (label: string): MenuItemSpec & { click(): void } => {
  const found = menuAt().find((entry) => entry.label === label);
  if (!found) throw new Error(`Tray menu is missing item "${label}"`);
  if (!found.click) throw new Error(`Tray item "${label}" has no click handler`);
  return found as MenuItemSpec & { click(): void };
};
// Status labels are presence-only: they carry no click handler by design.
const text = (label: string): MenuItemSpec => {
  const found = menuAt().find((entry) => entry.label === label);
  if (!found) throw new Error(`Tray menu is missing item "${label}"`);
  return found;
};

installElectronMock();
mock.module('fs', () => ({ existsSync }));
mock.module('../config', () => ({
  getConfig: () => config,
  setConfig,
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

  it('filters audio inputs and routes device selections through the onSelectDevice handler', async () => {
    const onSelectDevice = vi.fn();
    const { createTray, updateAudioDevices } = await import(`../tray?test=${Date.now()}-3`);
    createTray({ onOpenSettings: vi.fn(), onSelectDevice });

    updateAudioDevices([
      { deviceId: 'default', label: 'Default Mic', kind: 'audioinput' },
      { deviceId: 'speaker', label: 'Speaker', kind: 'audioinput' },
    ]);
    const latestMenu = menuAt();
    const deviceItems = latestMenu.find((entry) => entry.label === 'Microphone')?.submenu ?? [];
    const speakerItem = deviceItems.find((entry) => entry.label === 'Speaker');

    expect(deviceItems).toHaveLength(2);
    expect(deviceItems[0]?.checked).toBe(true);
    expect(speakerItem).toBeDefined();
    speakerItem?.click?.();

    expect(setConfig).toHaveBeenCalledWith('selectedDeviceId', 'speaker');
    expect(onSelectDevice).toHaveBeenCalledWith('speaker');
  });

  it('shows and toggles the session-only shortcut pause action', async () => {
    const togglePause = vi.fn();
    const { createTray, updateShortcutPauseState } = await import(`../tray?test=${Date.now()}-pause`);

    createTray({
      onOpenSettings: vi.fn(),
      isShortcutsPaused: () => false,
      onTogglePause: togglePause,
    });
    expect(item('Pause global shortcuts')).toMatchObject({ type: 'checkbox', checked: false });
    item('Pause global shortcuts').click();
    expect(togglePause).toHaveBeenCalledWith(true);

    updateShortcutPauseState(true);
    expect(item('Pause global shortcuts').checked).toBe(true);
    item('Pause global shortcuts').click();
    expect(togglePause).toHaveBeenLastCalledWith(false);
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

    expect(text('Shuddhalekhan v4.0.0 · Up to date')).toBeDefined();
    expect(item('Check for updates').enabled).toBe(true);
  });

  it('replaces the check action with install timing once an update downloads', async () => {
    const { createTray, updateUpdaterStatus } = await import(`../tray?test=${Date.now()}-downloaded`);

    createTray({ onOpenSettings: vi.fn() });
    updateUpdaterStatus({
      state: 'downloaded',
      currentVersion: '4.0.0',
      availableVersion: '4.1.0',
      releaseNotes: [],
      message: 'Shuddhalekhan v4.1.0 is ready to install.',
      checkedAt: new Date().toISOString(),
    });

    expect(text('Shuddhalekhan v4.0.0 · v4.1.0 installs on exit')).toMatchObject({ enabled: false });
    expect(menuAt().some((entry) => entry.label?.startsWith('Check'))).toBe(false);
  });

  it('shows a check for updates item that triggers the check handler', async () => {
    const checkHandler = vi.fn();
    const { createTray } = await import(`../tray?test=${Date.now()}-check-updates`);

    createTray({ onOpenSettings: vi.fn(), onCheckForUpdates: checkHandler });

    const checkItem = item('Check for updates');
    expect(checkItem.enabled).toBe(true);
    checkItem.click();
    expect(checkHandler).toHaveBeenCalled();
  });

  it('disables the check for updates item while checking', async () => {
    const { createTray, updateUpdaterStatus } = await import(`../tray?test=${Date.now()}-checking-state`);

    createTray({ onOpenSettings: vi.fn() });
    updateUpdaterStatus({
      state: 'checking',
      currentVersion: '4.0.0',
      message: 'Checking for updates...',
      checkedAt: null,
    });

    expect(item('Checking for updates…')).toMatchObject({ enabled: false });
  });

  it('exposes paste and copy last transcript actions when handlers are provided', async () => {
    const pasteHandler = vi.fn();
    const copyHandler = vi.fn();
    const { createTray } = await import(`../tray?test=${Date.now()}-recovery`);

    createTray({ onOpenSettings: vi.fn(), onPasteLastTranscript: pasteHandler, onCopyLastTranscript: copyHandler });

    const pasteItem = item('Paste last transcript');
    expect(pasteItem.enabled).toBe(true);
    pasteItem.click();
    expect(pasteHandler).toHaveBeenCalled();

    const copyItem = item('Copy last transcript');
    expect(copyItem.enabled).toBe(true);
    copyItem.click();
    expect(copyHandler).toHaveBeenCalled();
  });

  it('disables recovery actions when no handlers are provided', async () => {
    const { createTray } = await import(`../tray?test=${Date.now()}-no-recovery`);

    createTray({ onOpenSettings: vi.fn() });

    expect(item('Paste last transcript')).toMatchObject({ enabled: false });
    expect(item('Copy last transcript')).toMatchObject({ enabled: false });
  });
});
