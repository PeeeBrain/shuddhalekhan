import { useEffect, useRef } from 'react';
import { prepareStream, recreateStream, startRecording, stopRecording, enumerateDevices, setSelectedDeviceId } from './audio-capture';
import { RecordingPopup } from './RecordingPopup';
import { SettingsWindow } from './SettingsWindow';
import { AgentToast } from './AgentToast';
import type { RecordingIntent } from '../types/ipc';

async function sendAudioDevices(): Promise<void> {
  const devices = await enumerateDevices();
  window.electronAPI?.send('audio-devices', devices);
}

function AudioWindow() {
  const startPromiseRef = useRef<Promise<void> | null>(null);

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
    const unsubscribe = window.electronAPI.subscribe('audio:start-recording', () => {
      startPromiseRef.current = startRecording()
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
          startPromiseRef.current = null;
        });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
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
  }, []);

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

  return null;
}

export default App;
