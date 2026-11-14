import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AppState, Linking, Platform } from 'react-native';
import { AudioModule, AudioQuality, IOSOutputFormat, RecordingPresets, setAudioModeAsync, useAudioRecorder, type RecordingOptions } from 'expo-audio';
import { fetch } from 'expo/fetch';
import { File } from 'expo-file-system';
import { MobileController, type Recorder, type RecordingIntent } from './controller';
import { chatGptAuth, loadSettings, saveSettings } from './native-settings';
import { localModelKey, transcribeOnDevice, useOnDeviceModel } from './on-device';
import { signGoogleJwt } from './native-google-auth';
import { useKeyboardSession } from './useKeyboardSession';
import { agentCredentialsReady, recordingLimitSeconds, recordingLimits } from './providers';
import { agentActivity, onAgentApprovalAction, onAgentRunStopped } from './native-agent-activity';

const recordingOptions: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  fileName: 'shuddhalekhan-recording',
  extension: '.wav', sampleRate: 16000, numberOfChannels: 1, bitRate: 256000, isMeteringEnabled: false,
  ios: { extension: '.wav', outputFormat: IOSOutputFormat.LINEARPCM, audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
};
const keyboardSessionLink = /^shuddhalekhan:\/\/keyboard-session(?:[/?#]|$)/;
// iOS delivers an opening link before the app is active; the session needs the foreground for audio and the pasteboard.
// Leaving before activation drops the link rather than starting a session on a later, unrelated open.
const whenActive = () => new Promise<boolean>(resolve => {
  if (AppState.currentState === 'active') return resolve(true);
  const subscription = AppState.addEventListener('change', next => {
    if (next === 'inactive') return;
    subscription.remove();
    resolve(next === 'active');
  });
});

export function useMobileApp() {
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
          if (recordingFile.size > recordingLimits['on-device'].maxBytes) throw new Error('Recording is too large. Keep it under five minutes.');
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
    return new MobileController({ recorder: nativeRecorder, fetch, loadSettings, saveSettings, signGoogleJwt, activity: agentActivity, chatgpt: chatGptAuth,
      transcribeOnDevice: async (signal, language) => {
        if (!recordingFile?.exists) throw new Error('The recording file is unavailable. Record again.');
        return transcribeOnDevice(recordingFile.uri, signal, language);
      },
    });
  });
  const { keyboardSession, startKeyboardSession, stopKeyboardSession } = useKeyboardSession(controller.handleKeyboardSession);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const chatgpt = useSyncExternalStore(chatGptAuth.subscribe, chatGptAuth.getSnapshot);
  const { localModels, installLocalModel, preparingModel } = useOnDeviceModel(
    state.phase !== 'loading' && state.settings.transcriptionSource === 'on-device' ? state.settings.language : null,
  );
  const [now, setNow] = useState(Date.now);

  const startSession = async () => {
    if (controller.getSnapshot().phase !== 'idle') throw new Error('Finish the current command first.');
    const settings = controller.getSnapshot().settings;
    // Agent readiness is fixed for the session; a cold launch from the keyboard must not read sign-in before it loads.
    await startKeyboardSession(settings.language, async () => {
      await chatGptAuth.initialize();
      return settings.agentEnabled && agentActivity !== undefined &&
        (settings.agentProvider === 'chatgpt' ? chatGptAuth.getSnapshot().status === 'signed-in' && chatGptAuth.getSnapshot().planUsage :
          agentCredentialsReady(settings));
    });
  };
  // Links arrive in a mount-time listener; it calls the latest start, not the first render's.
  // The session Live Activity opens the same link, so a live session is left alone.
  const startFromLink = async () => { if (!keyboardSession.active) await startSession(); };
  const startSessionRef = useRef(startFromLink);
  useEffect(() => { startSessionRef.current = startFromLink; });

  useEffect(() => {
    controllerRef.current = controller;
    void controller.initialize();
    void chatGptAuth.initialize();
    const stopped = onAgentRunStopped(controller.agentRunStopped);
    const approvalAction = onAgentApprovalAction(() => { void controller.consumeApprovalAction(); });
    const open = (url: string) => {
      void Promise.all([controller.initialize(), whenActive()]).then(([, active]) => {
        if (!keyboardSessionLink.test(url)) return controller.openActivity(url);
        // The keyboard opens this when tapped without a session; it resumes its own intent once the session is live.
        if (!active) return;
        startSessionRef.current().catch((e: unknown) => Alert.alert('Keyboard session', e instanceof Error ? e.message : 'Could not start the session.'));
      });
    };
    const links = Linking.addEventListener('url', event => open(event.url));
    void Linking.getInitialURL().then(url => { if (url) open(url); }).catch(() => {});
    const subscription = AppState.addEventListener('change', next => {
      // The permission prompt and share sheet can make iOS inactive without backgrounding the app.
      if (next === 'background') void controller.enterBackground();
      if (next === 'active') void controller.enterForeground();
    });
    return () => { subscription.remove(); links.remove(); stopped?.remove(); approvalAction?.remove(); controllerRef.current = null; controller.cancel(); };
  }, [controller]);

  useEffect(() => {
    if (state.phase !== 'recording' || state.recordingStartedAt === null) return;
    const started = state.recordingStartedAt;
    const timer = setInterval(() => {
      const currentTime = Date.now();
      const elapsed = Math.floor((currentTime - started) / 1000);
      setNow(currentTime);
      if (elapsed >= recordingLimitSeconds(controller.getSnapshot().settings)) void controller.stopRecording();
    }, 1000);
    return () => clearInterval(timer);
  }, [controller, state.phase, state.recordingStartedAt]);

  return {
    ...state, elapsedSeconds: state.phase === 'recording' && state.recordingStartedAt !== null ? Math.max(0, Math.floor((now - state.recordingStartedAt) / 1000)) : 0,
    chatgpt, signInChatGpt: chatGptAuth.signIn, signOutChatGpt: chatGptAuth.signOut, listChatGptModels: chatGptAuth.listModels,
    localModel: localModels[localModelKey(state.settings.language)], localModels, installLocalModel, preparingModel,
    keyboardSession, stopKeyboardSession, startKeyboardSession: startSession,
    // The keyboard session holds the microphone, so recording here ends it first.
    // The controller is told directly rather than waiting for the native end event.
    startRecording: async (intent: RecordingIntent) => {
      if (keyboardSession.active) {
        await stopKeyboardSession();
        await controller.handleKeyboardSession({ endsAt: 0, phase: 'idle', agentReady: false });
      }
      await controller.startRecording(intent);
    },
    stopRecording: controller.stopRecording, cancel: controller.cancel,
    retryAgent: controller.retryAgent, resolveApproval: controller.resolveApproval,
    saveSettings: controller.saveSettings, resetSettings: controller.resetSettings,
    clearResults: controller.clearResults, dismissError: controller.dismissError,
  };
}
