import { useEffect, useRef } from 'react';
import { prepareStream, recreateStream, startRecording, stopRecording, enumerateDevices, setSelectedDeviceId } from './audio-capture';
import { RecordingPopup } from './RecordingPopup';
import { SettingsWindow } from './SettingsWindow';
import { AgentToast } from './AgentToast';
import { RuntimeShellSurface } from './RuntimeShellSurface';
import type { RecordingIntent, RuntimeAudioCommand } from '../types/ipc';

async function sendAudioDevices(): Promise<void> {
  const devices = await enumerateDevices();
  window.electronAPI?.send('audio-devices', devices);
}

export function AudioWindow({ runtime = false }: { runtime?: boolean }) {
  const startPromiseRef = useRef<Promise<void> | null>(null);
  const commandRef = useRef<RuntimeAudioCommand | null>(null);

  useEffect(() => {
    window.electronAPI?.invoke('config:get').then((config) => {
      setSelectedDeviceId(config.selectedDeviceId);
      return prepareStream();
    }).then(() => {
      void sendAudioDevices().catch((err) => {
        console.error('Failed to enumerate audio devices:', err);
      });
    }).catch((err) => {
      console.error('Failed to prepare audio stream:', err);
    });
  }, []);

  useEffect(() => {
    if (runtime) return undefined;
    const unsubscribe = window.electronAPI.subscribe('audio:start-recording', () => {
      startPromiseRef.current = startRecording()
        .then(() => {
          window.electronAPI?.send('audio-capture-started');
          void sendAudioDevices().catch((err) => {
            console.error('Failed to refresh audio devices after recording started:', err);
          });
        })
        .catch((err) => {
          console.error('Failed to start recording:', err);
          throw err;
        })
        .finally(() => {
          startPromiseRef.current = null;
        });
    });
    return unsubscribe;
  }, [runtime]);

  useEffect(() => {
    if (runtime) return undefined;
    const unsubscribe = window.electronAPI.subscribe('audio:stop-recording', async () => {
      try {
        await startPromiseRef.current;
        const audioData = stopRecording();
        window.electronAPI?.send('audio-data-ready', audioData.buffer);
      } catch (err) {
        console.error('Failed to stop recording:', err);
      }
    });
    return unsubscribe;
  }, [runtime]);

  useEffect(() => {
    if (!runtime) return undefined;
    const unsubscribeStart = window.electronAPI.subscribe('runtime:audio-start', (command) => {
      commandRef.current = command;
      startPromiseRef.current = startRecording()
        .then(() => window.electronAPI?.send('audio-capture-started'))
        .catch((err) => {
          commandRef.current = null;
          console.error('Failed to start runtime recording:', err);
          throw err;
        })
        .finally(() => { startPromiseRef.current = null; });
    });
    const unsubscribeStop = window.electronAPI.subscribe('runtime:audio-stop', async (command) => {
      if (
        commandRef.current?.generation !== command.generation
        || commandRef.current.recordingSessionId !== command.recordingSessionId
        || commandRef.current.sequence !== command.sequence
      ) return;
      try {
        await startPromiseRef.current;
        const audioData = stopRecording();
        commandRef.current = null;
        window.electronAPI?.send(
          'runtime:audio-data-ready',
          command.generation,
          command.recordingSessionId,
          command.sequence,
          audioData.buffer,
        );
      } catch (err) {
        commandRef.current = null;
        console.error('Failed to stop runtime recording:', err);
      }
    });
    return () => {
      unsubscribeStart();
      unsubscribeStop();
      if (commandRef.current) stopRecording();
      commandRef.current = null;
    };
  }, [runtime]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.subscribe('audio:recreate-stream', (deviceId: string | null) => {
      recreateStream(deviceId).catch((err) => {
        console.error('Failed to recreate audio stream for device change:', err);
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    window.electronAPI?.send('audio-window-ready');
  }, []);

  return null;
}

function useSurfacePaintProxy(surface: string): void {
  useEffect(() => {
    const reportPaintProxy = () => {
      let firstFrame = 0;
      let secondFrame = 0;
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
          window.electronAPI?.send('surface-paint-proxy', surface);
        });
      });
      return () => {
        cancelAnimationFrame(firstFrame);
        if (secondFrame) cancelAnimationFrame(secondFrame);
      };
    };

    const cancelInitial = reportPaintProxy();
    const unsubscribe = window.electronAPI?.subscribe('surface:request-paint-proxy', (requestedSurface) => {
      if (requestedSurface === surface) reportPaintProxy();
    });
    return () => {
      cancelInitial();
      unsubscribe?.();
    };
  }, [surface]);
}

function App() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const surface = hash.startsWith('recording') || hash === 'runtime'
    ? 'recording'
    : hash.split('?')[0] || 'unknown';
  useSurfacePaintProxy(surface);

  if (hash.startsWith('recording')) {
    const params = new URLSearchParams(hash.split('?')[1] ?? '');
    const mode = params.get('mode') === 'agent' ? 'agent' : 'dictation';
    return <RecordingPopup initialMode={mode as RecordingIntent} />;
  }

  if (hash === 'audio') {
    return <AudioWindow />;
  }

  if (hash === 'runtime') {
    return (
      <>
        <AudioWindow runtime />
        <RecordingPopup initialMode="dictation" />
        <RuntimeShellSurface />
      </>
    );
  }

  if (hash === 'settings') {
    return <SettingsWindow />;
  }

  if (hash === 'agent-toast') {
    return <AgentToast />;
  }

  return null;
}

export default App;
