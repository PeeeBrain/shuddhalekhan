import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

const vi = { fn: mock, mock: mock.module };
const originalConsoleError = console.error;
const consoleError = vi.fn();

type UpdaterListener = (...args: any[]) => void;

const updaterListeners = new Map<string, UpdaterListener>();
const checkForUpdatesMock = vi.fn();
const quitAndInstall = vi.fn();
const autoUpdater = {
  autoDownload: false,
  on: vi.fn((event: string, listener: UpdaterListener) => {
    updaterListeners.set(event, listener);
  }),
  checkForUpdates: checkForUpdatesMock,
  quitAndInstall,
};

installElectronMock();
mock.module('electron-updater', () => ({ autoUpdater }));

describe('updater', () => {
  afterAll(() => {
    console.error = originalConsoleError;
  });

  beforeEach(() => {
    resetElectronMock();
    console.error = consoleError;
    consoleError.mockClear();
    updaterListeners.clear();
    autoUpdater.autoDownload = false;
    autoUpdater.on.mockClear();
    checkForUpdatesMock.mockReset();
    quitAndInstall.mockClear();
  });

  it('reports development builds as unavailable for updates', async () => {
    const { checkForUpdates } = await import(`../updater?test=${Date.now()}-dev`);

    const status = await checkForUpdates();

    expect(status).toEqual(expect.objectContaining({
      state: 'latest',
      currentVersion: '4.0.0',
      latestVersion: '4.0.0',
      message: 'Update checks run only in the packaged Windows app.',
    }));
    expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Updates Unavailable in Development',
    }));
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it('publishes update lifecycle status changes', async () => {
    electronMock.app.isPackaged = true;
    checkForUpdatesMock.mockResolvedValue({ updateInfo: { version: '3.0.3' } });
    const onStatusChanged = vi.fn();
    const { setupUpdater, getUpdateStatus } = await import(`../updater?test=${Date.now()}-events`);

    setupUpdater(onStatusChanged);
    updaterListeners.get('checking-for-update')?.();
    updaterListeners.get('update-available')?.({ version: '3.0.3' });
    updaterListeners.get('download-progress')?.({ percent: 42.4 });
    updaterListeners.get('update-downloaded')?.({ version: '3.0.3' });

    expect(autoUpdater.autoDownload).toBe(true);
    expect(checkForUpdatesMock).toHaveBeenCalled();
    expect(onStatusChanged).toHaveBeenCalledWith(expect.objectContaining({
      state: 'checking',
      currentVersion: '4.0.0',
    }));
    expect(onStatusChanged).toHaveBeenCalledWith(expect.objectContaining({
      state: 'available',
      availableVersion: '3.0.3',
    }));
    expect(onStatusChanged).toHaveBeenCalledWith(expect.objectContaining({
      state: 'downloading',
      availableVersion: '3.0.3',
      percent: 42,
    }));
    expect(getUpdateStatus()).toEqual(expect.objectContaining({
      state: 'downloaded',
      availableVersion: '3.0.3',
    }));
  });

  it('records packaged update check failures', async () => {
    electronMock.app.isPackaged = true;
    checkForUpdatesMock.mockRejectedValue(new Error('network unavailable with headers and stack trace'));
    const { checkForUpdates, getUpdateStatus } = await import(`../updater?test=${Date.now()}-error`);

    const status = await checkForUpdates();

    expect(status).toEqual(expect.objectContaining({
      state: 'error',
      message: 'Update check failed. Please try again later.',
    }));
    expect(getUpdateStatus()).toEqual(status);
    expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      detail: 'Shuddhalekhan could not reach a valid update release. If this keeps happening, install the latest release manually from GitHub.',
    }));
  });

  it('does not leave stale status when update info is missing', async () => {
    electronMock.app.isPackaged = true;
    checkForUpdatesMock.mockResolvedValue(null);
    const { checkForUpdates, getUpdateStatus } = await import(`../updater?test=${Date.now()}-missing-info`);

    const status = await checkForUpdates();

    expect(status).toEqual(expect.objectContaining({
      state: 'error',
      message: 'Update check failed: no update information was returned.',
    }));
    expect(getUpdateStatus()).toEqual(status);
    expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      detail: 'The update service did not return update information. Please try again later.',
    }));
  });
});
