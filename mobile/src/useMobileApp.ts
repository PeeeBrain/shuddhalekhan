import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { AudioModule, AudioQuality, IOSOutputFormat, RecordingPresets, setAudioModeAsync, useAudioRecorder, type RecordingOptions } from 'expo-audio';
import { fetch } from 'expo/fetch';
import { File } from 'expo-file-system';
import { MobileController, type Recorder } from './controller';
import { loadSettings, saveSettings } from './native-settings';
import { transcribeOnDevice, useKeyboardSession, useOnDeviceModel } from './on-device';

const recordingOptions: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  fileName: 'shuddhalekhan-recording',
  extension: '.wav', sampleRate: 16000, numberOfChannels: 1, bitRate: 256000, isMeteringEnabled: false,
  ios: { extension: '.wav', outputFormat: IOSOutputFormat.LINEARPCM, audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
};

export function useMobileApp() {
  const { localModel, installLocalModel } = useOnDeviceModel();
  const { keyboardSession, startKeyboardSession, stopKeyboardSession } = useKeyboardSession();
  const controllerRef = useRef<MobileController | null>(null);
  const recorder = useAudioRecorder(recordingOptions, status => {
    if (status.hasError || status.isFinished || status.mediaServicesDidReset) controllerRef.current?.recordingInterrupted();
  });
  const [controller] = useState(() => {
    let prepared = false;
    let recordingFile: File | null = null;
    const nativeRecorder: Recorder = {
      async requestPermission() {
        if (Platform.OS !== 'ios') throw new Error('This build currently supports iOS recording.');
        try { return (await AudioModule.requestRecordingPermissionsAsync()).granted; }
        catch { throw new Error('Could not request microphone access. Check iOS permissions.'); }
      },
      async start(signal) {
        signal.throwIfAborted();
        try {
          await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: false });
          signal.throwIfAborted();
          await recorder.prepareToRecordAsync();
          prepared = true;
          if (recorder.uri) recordingFile = new File(recorder.uri);
          signal.throwIfAborted();
          recorder.record();
          if (!recorder.isRecording) throw new Error();
        } catch (error) {
          if (signal.aborted) throw error;
          // Native error causes can include local recording paths; keep the UI error bounded.
          // oxlint-disable-next-line preserve-caught-error
          throw new Error('Could not start recording. Check microphone permissions and audio input.');
        }
      },
      async stop() {
        try {
          await recorder.stop();
          prepared = false;
          if (!recorder.uri) throw new Error();
          recordingFile = new File(recorder.uri);
          if (!recordingFile.exists || recordingFile.size <= 44) throw new Error();
          if (recordingFile.size > 15_000_000) throw new Error('Recording is too large. Keep it under five minutes.');
          return recordingFile;
        } catch { throw new Error('Could not read the recording. Record again and speak for at least a second.'); }
      },
      async discard() {
        try {
          if (prepared) { await recorder.stop(); prepared = false; }
        } finally {
          try {
            if (recordingFile?.exists) recordingFile.delete();
            recordingFile = null;
          } finally {
            await setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false });
          }
        }
      },
    };
    return new MobileController({ recorder: nativeRecorder, fetch, loadSettings, saveSettings,
      transcribeOnDevice: async signal => {
        if (!recordingFile?.exists) throw new Error('The recording file is unavailable. Record again.');
        return transcribeOnDevice(recordingFile.uri, signal);
      },
    });
  });
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    controllerRef.current = controller;
    void controller.initialize();
    const subscription = AppState.addEventListener('change', next => {
      // The permission prompt and share sheet can make iOS inactive without backgrounding the app.
      if (next === 'background') controller.cancel();
    });
    return () => { subscription.remove(); controllerRef.current = null; controller.cancel(); };
  }, [controller]);

  useEffect(() => {
    if (state.phase !== 'recording' || state.recordingStartedAt === null) return;
    const started = state.recordingStartedAt;
    const timer = setInterval(() => {
      const currentTime = Date.now();
      const elapsed = Math.floor((currentTime - started) / 1000);
      setNow(currentTime);
      if (elapsed >= 300) void controller.stopRecording();
    }, 1000);
    return () => clearInterval(timer);
  }, [controller, state.phase, state.recordingStartedAt]);

  return {
    ...state, elapsedSeconds: state.phase === 'recording' && state.recordingStartedAt !== null ? Math.max(0, Math.floor((now - state.recordingStartedAt) / 1000)) : 0,
    localModel, installLocalModel,
    keyboardSession, stopKeyboardSession,
    startKeyboardSession: async () => {
      // The session holds the microphone; in-app recording stays disabled until it ends.
      if (controller.getSnapshot().phase !== 'idle') throw new Error('Finish the current command first.');
      await startKeyboardSession();
    },
    startRecording: controller.startRecording, stopRecording: controller.stopRecording, cancel: controller.cancel,
    retryAgent: controller.retryAgent, resolveApproval: controller.resolveApproval,
    saveSettings: controller.saveSettings, resetSettings: controller.resetSettings,
    clearResults: controller.clearResults, dismissError: controller.dismissError,
  };
}
