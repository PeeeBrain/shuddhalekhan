import { useEffect, useState } from 'react';
import { startRecording, stopRecording, enumerateDevices, setSelectedDeviceId } from './audio-capture';
import { RecordingPopup } from './RecordingPopup';
import { SettingsWindow } from './SettingsWindow';
import type { AppInfo, RecordingIntent, UpdateStatus } from '../types/ipc';
import './App.css';

async function sendAudioDevices(): Promise<void> {
  const devices = await enumerateDevices();
  window.electronAPI?.send('audio-devices', devices);
}

function AudioWindow() {
  useEffect(() => {
    let startPromise: Promise<void> | null = null;

    window.electronAPI?.invoke('config:get').then((config) => {
      setSelectedDeviceId(config.selectedDeviceId);
    }).catch((err) => {
      console.error('Failed to load audio config:', err);
    });

    // Enumerate devices on mount and send to main process
    sendAudioDevices().then(() => {
      console.log('Audio devices sent to main process');
    }).catch((err) => {
      console.error('Failed to enumerate audio devices:', err);
    });

    // Listen for commands from main process
    const removeStart = window.electronAPI?.on('audio:start-recording', () => {
      startPromise = startRecording()
        .then(() => {
          void sendAudioDevices().catch((err) => {
            console.error('Failed to refresh audio devices after recording started:', err);
          });
        })
        .catch((err) => {
          console.error('Failed to start recording:', err);
          throw err;
        })
        .finally(() => {
          startPromise = null;
        });
    });

    const removeStop = window.electronAPI?.on('audio:stop-recording', async () => {
      try {
        await startPromise;
        const audioData = stopRecording();
        window.electronAPI?.send('audio-data-ready', audioData.buffer);
      } catch (err) {
        console.error('Failed to stop recording:', err);
      }
    });

    const removeSelect = window.electronAPI?.on('audio:select-device', (deviceId: string) => {
      setSelectedDeviceId(deviceId);
    });

    window.electronAPI?.send('audio-window-ready');

    return () => {
      removeStart?.();
      removeStop?.();
      removeSelect?.();
    };
  }, []);

  return null;
}

function MainWindow() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    window.electronAPI?.invoke('app:get-info')
      .then(setAppInfo)
      .catch((err) => {
        console.error('Failed to load app info:', err);
      });

    window.electronAPI?.invoke('updater:get-status')
      .then(setUpdateStatus)
      .catch((err) => {
        console.error('Failed to load update status:', err);
      });

    return window.electronAPI?.on('updater:status-changed', setUpdateStatus);
  }, []);

  const checkForUpdates = () => {
    window.electronAPI?.invoke('updater:check')
      .then(setUpdateStatus)
      .catch((err) => {
        console.error('Failed to check for updates:', err);
      });
  };

  return (
    <main className="container">
      <section className="status-panel" aria-label="Application status">
        <div className="title-row">
          <div>
            <h1>Shuddhalekhan</h1>
            <p className="version">Version {appInfo?.version ?? '...'}</p>
          </div>
          <span className="state-badge">{getStatusLabel(updateStatus)}</span>
        </div>

        <div className="update-box">
          <p>{updateStatus?.message ?? 'Update status has not loaded yet.'}</p>
          {updateStatus?.checkedAt ? (
            <time dateTime={updateStatus.checkedAt}>Checked {formatCheckedAt(updateStatus.checkedAt)}</time>
          ) : null}
        </div>

        <button
          type="button"
          onClick={checkForUpdates}
          disabled={updateStatus?.state === 'checking'}
        >
          {updateStatus?.state === 'checking' ? 'Checking...' : 'Check for Updates'}
        </button>

        <div className="hint-grid">
          <span>Hold Ctrl+Win</span>
          <span>Release to transcribe</span>
        </div>
      </section>
    </main>
  );
}

function getStatusLabel(status: UpdateStatus | null): string {
  if (!status) return 'Loading';
  switch (status.state) {
    case 'available':
    case 'downloading':
    case 'downloaded':
      return 'Update';
    case 'latest':
      return 'Latest';
    case 'error':
      return 'Issue';
    case 'checking':
      return 'Checking';
    case 'idle':
      return 'Ready';
  }
}

function formatCheckedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function App() {
  const hash = window.location.hash.replace(/^#\/?/, '');

  if (hash.startsWith('recording')) {
    const params = new URLSearchParams(hash.split('?')[1] ?? '');
    const mode = params.get('mode') === 'agent' ? 'agent' : 'dictation';
    return <RecordingPopup initialMode={mode as RecordingIntent} />;
  }

  if (hash === 'audio') {
    return <AudioWindow />;
  }

  if (hash === 'settings') {
    return <SettingsWindow />;
  }

  return <MainWindow />;
}

export default App;
