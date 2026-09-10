import { useEffect, useRef } from 'react';
import {
  acknowledgeRealtimeChunk,
  enumerateDevices,
  MAX_IN_FLIGHT_PCM_CHUNKS,
  prepareStream,
  recreateStream,
  setSelectedDeviceId,
  startRecording,
  stopRecording,
} from './audio-capture';
import { SettingsWindow } from './SettingsWindow';
import { RuntimeShellSurface } from './RuntimeShellSurface';
import type { RuntimeAudioCommand } from '../types/ipc';

async function sendAudioDevices(): Promise<void> {
  const devices = await enumerateDevices();
  window.electronAPI?.send('audio-devices', devices);
}

export function AudioWindow() {
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
    const unsubscribeStart = window.electronAPI.subscribe('runtime:audio-start', (command) => {
      commandRef.current = command;
      startPromiseRef.current = startRecording(command.streaming ? {
        recordingSessionId: command.recordingSessionId,
        maxInFlightChunks: MAX_IN_FLIGHT_PCM_CHUNKS,
        onPcmChunk: (chunk) => {
          window.electronAPI?.send(
            'runtime:audio-chunk',
            command.generation,
            command.recordingSessionId,
            command.sequence,
            chunk.sequence,
            chunk.pcm.buffer,
          );
        },
        onRealtimeDisabled: () => {
          window.electronAPI?.send(
            'runtime:audio-stream-disabled',
            command.generation,
            command.recordingSessionId,
            command.sequence,
          );
        },
      } : undefined)
        .then(() => window.electronAPI?.send('audio-capture-started'))
        .catch((err) => {
          commandRef.current = null;
          console.error('Failed to start runtime recording:', err);
          window.electronAPI?.send(
            'runtime:audio-failed',
            command.generation,
            command.recordingSessionId,
            command.sequence,
          );
        })
        .finally(() => { startPromiseRef.current = null; });
    });
    const unsubscribeAccepted = window.electronAPI.subscribe(
      'runtime:audio-chunk-accepted',
      (generation, recordingSessionId, commandSequence, chunkSequence) => {
        if (
          commandRef.current?.generation !== generation
          || commandRef.current.recordingSessionId !== recordingSessionId
          || commandRef.current.sequence !== commandSequence
        ) return;
        acknowledgeRealtimeChunk(chunkSequence);
      },
    );
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
        window.electronAPI?.send(
          'runtime:audio-failed',
          command.generation,
          command.recordingSessionId,
          command.sequence,
        );
      }
    });
    return () => {
      unsubscribeStart();
      unsubscribeAccepted();
      unsubscribeStop();
      if (commandRef.current) stopRecording();
      commandRef.current = null;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI.subscribe('audio:recreate-stream', (deviceId: string | null) => {
      recreateStream(deviceId).catch((err) => {
        console.error('Failed to recreate audio stream for device change:', err);
      });
    });
    return unsubscribe;
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
  const surface = hash === 'runtime'
    ? 'recording'
    : hash.split('?')[0] || 'unknown';
  useSurfacePaintProxy(surface);

  if (hash === 'runtime') {
    return (
      <>
        <AudioWindow />
        <RuntimeShellSurface />
      </>
    );
  }

  if (hash === 'settings') {
    return <SettingsWindow />;
  }

  return null;
}

export default App;
