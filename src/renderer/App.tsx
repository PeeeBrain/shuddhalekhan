import { useEffect, useState } from 'react';
import { startRecording, stopRecording, enumerateDevices, setSelectedDeviceId } from './audio-capture';
import { RecordingPopup } from './RecordingPopup';
import { SettingsWindow } from './SettingsWindow';
import { AgentToast } from './AgentToast';
import type { AppInfo, RecordingIntent, UpdateStatus } from '../types/ipc';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

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

  const statusVariant = getStatusVariant(updateStatus);

  return (
    <main className="flex min-h-screen flex-col justify-center bg-background p-6">
      <section className="mx-auto w-full max-w-md space-y-5" aria-label="Application status">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Shuddhalekhan</h1>
            <p className="mt-1 text-sm text-muted-foreground">Version {appInfo?.version ?? '...'}</p>
          </div>
          <Badge variant={statusVariant.variant} className={statusVariant.className}>
            {getStatusLabel(updateStatus)}
          </Badge>
        </div>

        <Card className="border-border/60">
          <CardContent className="space-y-1.5 pt-6">
            <p className="text-sm text-foreground">{updateStatus?.message ?? 'Update status has not loaded yet.'}</p>
            {updateStatus?.checkedAt ? (
              <time dateTime={updateStatus.checkedAt} className="block text-xs text-muted-foreground">
                Checked {formatCheckedAt(updateStatus.checkedAt)}
              </time>
            ) : null}
          </CardContent>
        </Card>

        <Button
          onClick={checkForUpdates}
          disabled={updateStatus?.state === 'checking'}
          className="w-full"
        >
          {updateStatus?.state === 'checking' ? 'Checking...' : 'Check for Updates'}
        </Button>

        <div className="grid grid-cols-2 gap-2">
          <div className="flex h-[34px] items-center justify-center rounded-lg border border-border/60 bg-muted/50 px-3 text-xs text-muted-foreground">
            Hold Ctrl+Win
          </div>
          <div className="flex h-[34px] items-center justify-center rounded-lg border border-border/60 bg-muted/50 px-3 text-xs text-muted-foreground">
            Release to transcribe
          </div>
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

function getStatusVariant(status: UpdateStatus | null): { variant: 'default' | 'secondary' | 'destructive' | 'outline'; className?: string } {
  if (!status) return { variant: 'secondary' };
  switch (status.state) {
    case 'available':
    case 'downloading':
    case 'downloaded':
      return { variant: 'default', className: 'bg-primary text-primary-foreground' };
    case 'latest':
      return { variant: 'secondary' };
    case 'error':
      return { variant: 'destructive' };
    case 'checking':
      return { variant: 'outline' };
    case 'idle':
      return { variant: 'secondary' };
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

  if (hash === 'agent-toast') {
    return <AgentToast />;
  }

  return <MainWindow />;
}

export default App;
