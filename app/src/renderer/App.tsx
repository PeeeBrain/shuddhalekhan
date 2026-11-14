import { useEffect, useRef } from 'react';
import {
  acknowledgeRealtimeChunk,
  cancelRecording,
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

function sameCommand(current: RuntimeAudioCommand | null, next: Pick<RuntimeAudioCommand, 'generation' | 'recordingSessionId' | 'sequence'>): boolean {
  return current?.generation === next.generation
    && current.recordingSessionId === next.recordingSessionId
    && current.sequence === next.sequence;
}

// Each transition installs a fresh object, so async completions compare identity
// to learn whether a cancel, failure, or newer start retired them.
type AudioCapture =
  | { phase: 'idle' }
  | { phase: 'capturing'; command: RuntimeAudioCommand }
  | { phase: 'stopping'; command: RuntimeAudioCommand };

const IDLE: AudioCapture = { phase: 'idle' };

function ownsCommand(capture: AudioCapture, command: Pick<RuntimeAudioCommand, 'generation' | 'recordingSessionId' | 'sequence'>): boolean {
  return capture.phase !== 'idle' && sameCommand(capture.command, command);
}

export function AudioWindow() {
  const captureRef = useRef<AudioCapture>(IDLE);

  useEffect(() => {
    window.electronAPI?.invoke('config:get').then((config) => {
      setSelectedDeviceId(config.selectedDeviceId);
      // Host readiness must not wait on a permission prompt: each capture owns its startup deadline.
      window.electronAPI?.send('audio-stream-ready');
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
      // A start that was never stopped is superseded: drop it so it cannot
      // start late or emit audio under the old identity.
      cancelRecording();
      const capturing: AudioCapture = { phase: 'capturing', command };
      captureRef.current = capturing;
      const reportProcessorFailure = () => {
        const current = captureRef.current;
        if (current.phase === 'idle' || current.command !== command) return;
        captureRef.current = IDLE;
        window.electronAPI?.send('runtime:audio-failed',
          command.generation, command.recordingSessionId, command.sequence);
      };
      void startRecording({
        onSpoolChunk: async (chunkSequence, pcm) => {
          const written = await window.electronAPI.invoke(
            'runtime:audio-spool',
            command.generation,
            command.recordingSessionId,
            command.sequence,
            chunkSequence,
            pcm.buffer,
          );
          if (!written) throw new Error(`Main did not spool audio chunk ${chunkSequence}.`);
        },
        streaming: command.streaming ? {
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
        } : undefined,
        onFailure: reportProcessorFailure,
      })
        .then(() => {
          if (captureRef.current !== capturing) return;
          window.electronAPI.send('runtime:audio-ready',
            command.generation, command.recordingSessionId, command.sequence);
        })
        .catch((err) => {
          // A stop already in flight owns the failure report.
          if (captureRef.current !== capturing) return;
          captureRef.current = IDLE;
          console.error('Failed to start runtime recording:', err);
          window.electronAPI?.send(
            'runtime:audio-failed',
            command.generation,
            command.recordingSessionId,
            command.sequence,
          );
        });
    });
    // Acks keep flowing to a capture that is still draining after stop.
    const unsubscribeAccepted = window.electronAPI.subscribe(
      'runtime:audio-chunk-accepted',
      (generation, recordingSessionId, sequence, chunkSequence) => {
        const command = { generation, recordingSessionId, sequence };
        if (!ownsCommand(captureRef.current, command)) return;
        acknowledgeRealtimeChunk(recordingSessionId, chunkSequence);
      },
    );
    const unsubscribeStop = window.electronAPI.subscribe('runtime:audio-stop', async (command) => {
      const current = captureRef.current;
      if (current.phase !== 'capturing' || !sameCommand(current.command, command)) return;
      const stopping: AudioCapture = { phase: 'stopping', command: current.command };
      captureRef.current = stopping;
      try {
        const boundary = await stopRecording();
        if (captureRef.current !== stopping) return;
        if (!boundary) throw new Error('Audio capture ended without a final boundary.');
        window.electronAPI?.send(
          'runtime:audio-end',
          command.generation,
          command.recordingSessionId,
          command.sequence,
          boundary.chunkCount,
          boundary.sampleCount,
        );
      } catch (err) {
        if (captureRef.current !== stopping) return;
        console.error('Failed to stop runtime recording:', err);
        window.electronAPI?.send(
          'runtime:audio-failed',
          command.generation,
          command.recordingSessionId,
          command.sequence,
        );
      } finally {
        if (captureRef.current === stopping) captureRef.current = IDLE;
      }
    });
    const unsubscribeCancel = window.electronAPI.subscribe('runtime:audio-cancel', (command) => {
      if (!ownsCommand(captureRef.current, command)) return;
      captureRef.current = IDLE;
      cancelRecording();
    });
    return () => {
      unsubscribeStart();
      unsubscribeAccepted();
      unsubscribeStop();
      unsubscribeCancel();
      captureRef.current = IDLE;
      cancelRecording();
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

// Main gates Managed Local warmup on the first painted recording surface.
function useSurfacePaintProxy(surface: string): void {
  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        window.electronAPI?.send('surface-paint-proxy', surface);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
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
    return (
      <div className="flex h-screen flex-col">
        <div className="title-bar-drag" aria-hidden="true" />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SettingsWindow />
        </div>
      </div>
    );
  }

  return null;
}

export default App;
