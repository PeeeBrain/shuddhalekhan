import { autoUpdater } from 'electron-updater';
import { app, dialog } from 'electron';
import type { UpdateStatus } from '../types/ipc';

let statusListener: ((status: UpdateStatus) => void) | null = null;
let currentStatus: UpdateStatus = {
  state: 'idle',
  currentVersion: app.getVersion(),
  message: `Shuddhalekhan v${app.getVersion()}`,
  checkedAt: null,
};

function setStatus(status: UpdateStatus): void {
  currentStatus = status;
  statusListener?.(status);
}

function now(): string {
  return new Date().toISOString();
}

function getUpdateFailureMessage(): string {
  return 'Update check failed. Please try again later.';
}

function getUpdateFailureDetail(): string {
  return 'Shuddhalekhan could not reach a valid update release. If this keeps happening, install the latest release manually from GitHub.';
}

export function setupUpdater(onStatusChanged?: (status: UpdateStatus) => void): void {
  statusListener = onStatusChanged ?? null;

  autoUpdater.autoDownload = true;

  autoUpdater.on('checking-for-update', () => {
    setStatus({
      state: 'checking',
      currentVersion: app.getVersion(),
      message: 'Checking for updates...',
      checkedAt: currentStatus.checkedAt,
    });
  });

  autoUpdater.on('update-available', (info) => {
    const availableVersion = info.version;
    setStatus({
      state: 'available',
      currentVersion: app.getVersion(),
      availableVersion,
      message: `Shuddhalekhan v${availableVersion} is available. Downloading now...`,
      checkedAt: now(),
    });

    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Available',
        message: `Shuddhalekhan v${availableVersion} is available.`,
        detail: 'The update is downloading in the background. You will be prompted to restart when it is ready.',
        buttons: ['OK'],
      })
      .catch(() => {
        // ignore
      });
  });

  autoUpdater.on('download-progress', (progress) => {
    const availableVersion =
      currentStatus.state === 'available' ||
      currentStatus.state === 'downloading' ||
      currentStatus.state === 'downloaded'
        ? currentStatus.availableVersion
        : 'unknown';

    setStatus({
      state: 'downloading',
      currentVersion: app.getVersion(),
      availableVersion,
      percent: Number.isFinite(progress.percent) ? Math.round(progress.percent) : null,
      message: `Downloading Shuddhalekhan v${availableVersion}...`,
      checkedAt: currentStatus.checkedAt ?? now(),
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    setStatus({
      state: 'latest',
      currentVersion: app.getVersion(),
      latestVersion: info.version,
      message: `You're on the latest version: Shuddhalekhan v${app.getVersion()}.`,
      checkedAt: now(),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const availableVersion = info.version;
    setStatus({
      state: 'downloaded',
      currentVersion: app.getVersion(),
      availableVersion,
      message: `Shuddhalekhan v${availableVersion} is ready to install.`,
      checkedAt: currentStatus.checkedAt ?? now(),
    });

    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Ready',
        message: `Shuddhalekhan v${availableVersion} has been downloaded.`,
        detail: 'The application will restart to apply the update.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      })
      .catch(() => {
        // ignore
      });
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err);
    setStatus({
      state: 'error',
      currentVersion: app.getVersion(),
      message: getUpdateFailureMessage(),
      checkedAt: now(),
    });
  });

  void checkForUpdates({ silent: true });
}

export function getUpdateStatus(): UpdateStatus {
  return currentStatus;
}

export async function checkForUpdates(options: { silent?: boolean } = {}): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    const status: UpdateStatus = {
      state: 'latest',
      currentVersion: app.getVersion(),
      latestVersion: app.getVersion(),
      message: 'Update checks run only in the packaged Windows app.',
      checkedAt: now(),
    };
    setStatus(status);
    if (!options.silent) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'Updates Unavailable in Development',
        message: status.message,
        buttons: ['OK'],
      });
    }
    return status;
  }

  try {
    const result = await autoUpdater.checkForUpdates();
    if (result?.updateInfo) {
      if (!options.silent) {
        await showManualCheckResult(currentStatus);
      }
      return currentStatus;
    }
    const status: UpdateStatus = {
      state: 'error',
      currentVersion: app.getVersion(),
      message: 'Update check failed: no update information was returned.',
      checkedAt: now(),
    };
    setStatus(status);
    if (!options.silent) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Update Check Failed',
        message: 'Shuddhalekhan could not confirm whether an update is available.',
        detail: 'The update service did not return update information. Please try again later.',
        buttons: ['OK'],
      });
    }
    return status;
  } catch (err) {
    const status: UpdateStatus = {
      state: 'error',
      currentVersion: app.getVersion(),
      message: getUpdateFailureMessage(),
      checkedAt: now(),
    };
    console.error('Auto-updater manual check failed:', err);
    setStatus(status);
    if (!options.silent) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Update Check Failed',
        message: 'Shuddhalekhan could not check for updates.',
        detail: getUpdateFailureDetail(),
        buttons: ['OK'],
      });
    }
    return status;
  }

  return currentStatus;
}

async function showManualCheckResult(status: UpdateStatus): Promise<void> {
  if (status.state === 'latest') {
    await dialog.showMessageBox({
      type: 'info',
      title: 'No Updates Available',
      message: `You're on the latest version: Shuddhalekhan v${status.currentVersion}.`,
      buttons: ['OK'],
    });
  } else if (status.state === 'downloaded') {
    await dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `Shuddhalekhan v${status.availableVersion} is ready to install.`,
      detail: 'Restart the application to apply the update.',
      buttons: ['OK'],
    });
  }
}
