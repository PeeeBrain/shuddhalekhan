import { ipcMain } from 'electron';
import type {
  DictationTargetSnapshot,
  RecordingActivationMode,
  RecordingIntent,
} from '../types/ipc';
import { keyboardHook } from './native/keyboard';
import { captureForegroundTarget } from './native/target';
import { getRecordingPillWindow, hideRecordingPill, showRecordingPill, updateRecordingDurationWarning } from './recording-pill';
import { localWhisperCppTranscriber } from './whisper';
import type { RecognitionSettings, Transcriber } from './transcription';
import { createSingletonWindow } from './window-factory';

export interface RecordingResult {
  text: string;
  intent: RecordingIntent;
  targetSnapshot: DictationTargetSnapshot | null;
}

export interface AudioCapture {
  prepare(): void;
  beginCapture(): void;
  endCapture(): void;
  cancelCapture(): void;
  setSelectedDevice(deviceId: string | null): void;
  destroy?(): void;
  markReady?(): void;
  markCrashed?(reason: string): void;
  getWebContents?(): import('electron').WebContents | null;
}

export class ProductionAudioCapture implements AudioCapture {
  private windowController: ReturnType<typeof createSingletonWindow>;
  private isReady = false;
  private prepared = false;
  private pendingBegin = false;

  constructor(
    private readonly onCrash?: (reason: string) => void
  ) {
    this.windowController = createSingletonWindow({
      route: 'audio',
      options: {
        width: 1,
        height: 1,
        show: false,
        frame: false,
        transparent: true,
        skipTaskbar: true,
        focusable: false,
        webPreferences: {
          backgroundThrottling: false,
        },
      },
      onCreated: (win) => {
        win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
          console.error(`Audio window failed to load: ${errorCode} ${errorDescription}`);
        });
        win.webContents.on('render-process-gone', (_event, details) => {
          console.error(`Audio window render process gone: ${details.reason}`);
          this.handleCrash(details.reason);
        });
      },
    });
  }

  prepare(): void {
    if (this.prepared) return;
    this.windowController.create();
    this.prepared = true;
  }

  markReady(): void {
    this.isReady = true;
    if (this.pendingBegin) {
      this.pendingBegin = false;
      this.sendStart();
    }
  }

  markCrashed(reason: string): void {
    this.handleCrash(reason);
  }

  private handleCrash(reason: string): void {
    this.isReady = false;
    this.prepared = false;
    this.pendingBegin = false;
    this.onCrash?.(reason);
  }

  beginCapture(): void {
    if (!this.isReady) {
      this.pendingBegin = true;
      return;
    }
    this.sendStart();
  }

  endCapture(): void {
    this.pendingBegin = false;
    const win = this.windowController.get();
    if (win && !win.isDestroyed()) {
      win.webContents.send('audio:stop-recording');
    }
  }

  cancelCapture(): void {
    this.pendingBegin = false;
    const win = this.windowController.get();
    if (win && !win.isDestroyed()) {
      win.webContents.send('audio:stop-recording');
    }
  }

  setSelectedDevice(deviceId: string | null): void {
    this.isReady = false;
    this.pendingBegin = false;
    const win = this.windowController.get();
    if (win && !win.isDestroyed()) {
      win.webContents.send('audio:recreate-stream', deviceId);
    }
  }

  destroy(): void {
    this.windowController.destroy();
    this.isReady = false;
    this.prepared = false;
    this.pendingBegin = false;
  }

  getWebContents(): import('electron').WebContents | null {
    const win = this.windowController.get();
    return win && !win.isDestroyed() ? win.webContents : null;
  }

  private sendStart(): void {
    const win = this.windowController.get();
    if (win && !win.isDestroyed()) {
      win.webContents.send('audio:start-recording');
    }
  }
}

export interface KeyboardHook {
  start(
    onStart: (intent: RecordingIntent) => void,
    onStop: () => void,
    isAgentModeEnabled?: () => boolean,
    getActivationMode?: () => RecordingActivationMode
  ): void;
  stop(): void;
  recordingEndedExternally?(): void;
}

export interface RecordingSessionOptions {
  isAgentModeEnabled: () => boolean;
  getRecordingActivationMode?: () => RecordingActivationMode;
  getSelectedDeviceId?: () => string | null;
  getRecognitionSettings?: () => RecognitionSettings;
  getReadinessError?: () => Error | null;
  onResult?: (result: RecordingResult | null) => void | Promise<void>;
  onError?: (error: Error) => void;

  audioCapture?: AudioCapture;
  keyboardHook?: KeyboardHook;
  transcriber?: Transcriber;
  getTranscriber?: () => Transcriber;
  captureTarget?: () => DictationTargetSnapshot | null;
  showRecordingPill?: (intent: RecordingIntent) => void;
  hideRecordingPill?: () => void;
  updateDurationWarning?: (remainingSeconds: number | null) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class RecordingSession {
  private activeIntent: RecordingIntent | null = null;
  private targetSnapshot: DictationTargetSnapshot | null = null;
  private pendingEnd:
    | {
        resolve: (result: RecordingResult | null) => void;
        reject: (error: unknown) => void;
        intent: RecordingIntent;
      }
    | null = null;

  private isAgentModeEnabled: () => boolean;
  private getRecordingActivationMode: () => RecordingActivationMode;
  private audioCapture: AudioCapture;
  private keyboardHook: KeyboardHook;
  private getTranscriber: () => Transcriber;
  private getRecognitionSettings: () => RecognitionSettings;
  private getReadinessError: () => Error | null;
  private captureTarget: () => DictationTargetSnapshot | null;
  private showRecordingPillFn: (intent: RecordingIntent) => void;
  private hideRecordingPillFn: () => void;
  private updateDurationWarningFn: (remainingSeconds: number | null) => void;
  private setTimeoutFn: typeof setTimeout;
  private clearTimeoutFn: typeof clearTimeout;
  private durationTimers: Array<ReturnType<typeof setTimeout>> = [];
  private onResultCallback?: (result: RecordingResult | null) => void | Promise<void>;
  private onErrorCallback?: (error: Error) => void;
  private getSelectedDeviceId?: () => string | null;

  constructor(options: RecordingSessionOptions) {
    this.isAgentModeEnabled = options.isAgentModeEnabled;
    this.getRecordingActivationMode = options.getRecordingActivationMode ?? (() => 'push-to-talk');
    this.audioCapture = options.audioCapture ?? new ProductionAudioCapture(
      (reason) => this.markAudioWindowCrashed(reason)
    );
    this.keyboardHook = options.keyboardHook ?? keyboardHook;
    const defaultTranscriber = options.transcriber ?? localWhisperCppTranscriber;
    this.getTranscriber = options.getTranscriber ?? (() => defaultTranscriber);
    this.getRecognitionSettings = options.getRecognitionSettings ?? (() => ({
      language: 'auto',
      task: 'transcribe',
      dictionary: [],
      removeFillerWords: false,
    }));
    this.getReadinessError = options.getReadinessError ?? (() => null);
    this.captureTarget = options.captureTarget ?? captureForegroundTarget;
    this.showRecordingPillFn = options.showRecordingPill ?? showRecordingPill;
    this.hideRecordingPillFn = options.hideRecordingPill ?? hideRecordingPill;
    this.updateDurationWarningFn = options.updateDurationWarning ?? updateRecordingDurationWarning;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.onResultCallback = options.onResult;
    this.onErrorCallback = options.onError;
    this.getSelectedDeviceId = options.getSelectedDeviceId;
  }

  begin(intent: RecordingIntent = 'dictation'): void {
    if (this.activeIntent || this.pendingEnd) return;
    const readinessError = this.getReadinessError();
    if (readinessError) {
      this.onErrorCallback?.(readinessError);
      return;
    }
    this.activeIntent = intent;
    this.targetSnapshot = this.captureTarget();

    const deviceId = this.getSelectedDeviceId?.();
    console.log(`Starting recording session. Device: ${deviceId ?? 'default'}`);

    this.audioCapture.prepare();
    this.audioCapture.beginCapture();
    this.showRecordingPillFn(intent);
    this.scheduleDurationLimit(this.getTranscriber().capabilities.maxDurationSeconds);
  }

  async end(): Promise<RecordingResult | null> {
    if (!this.activeIntent) return null;

    this.clearDurationTimers();
    const intent = this.activeIntent;
    this.activeIntent = null;
    this.hideRecordingPillFn();
    this.audioCapture.endCapture();

    return new Promise((resolve, reject) => {
      this.pendingEnd = { resolve, reject, intent };
    });
  }

  async cancel(): Promise<void> {
    this.clearDurationTimers();
    this.activeIntent = null;
    this.targetSnapshot = null;
    this.hideRecordingPillFn();
    this.audioCapture.cancelCapture();
    this.pendingEnd?.resolve(null);
    this.pendingEnd = null;
  }

  isActive(): boolean {
    return this.activeIntent !== null;
  }

  markAudioWindowReady(): void {
    this.audioCapture.markReady?.();
  }

  markAudioWindowCrashed(reason: string): void {
    this.audioCapture.markCrashed?.(reason);
    const error = new Error(`Audio window crashed: ${reason}`);
    if (this.pendingEnd) {
      this.pendingEnd.reject(error);
      this.pendingEnd = null;
    }
    this.onErrorCallback?.(error);
  }

  async complete(audioData: Uint8Array): Promise<RecordingResult | null> {
    const pendingEnd = this.pendingEnd;
    this.pendingEnd = null;
    const intent = pendingEnd?.intent ?? this.activeIntent ?? 'dictation';
    this.activeIntent = null;

    if (audioData.byteLength <= 44) {
      console.warn(`Skipping empty WAV payload: ${audioData.byteLength} bytes`);
      audioData.fill(0);
      this.targetSnapshot = null;
      pendingEnd?.resolve(null);
      return null;
    }

    try {
      const text = await this.getTranscriber().transcribe({
        audio: audioData,
        recognition: this.getRecognitionSettings(),
      });
      const snapshot = this.targetSnapshot;
      this.targetSnapshot = null;
      const result = text ? { text, intent, targetSnapshot: snapshot } : null;
      pendingEnd?.resolve(result);
      if (this.onResultCallback) {
        void this.onResultCallback(result);
      }
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      pendingEnd?.reject(err);
      this.onErrorCallback?.(err);
      if (!pendingEnd) {
        throw err;
      }
      return null;
    } finally {
      audioData.fill(0);
      this.targetSnapshot = null;
    }
  }

  startKeyboardHook(onResult?: (result: RecordingResult | null) => void | Promise<void>): void {
    this.keyboardHook.start(
      (intent) => this.begin(intent),
      () => {
        void this.end().then((result) => {
          if (onResult && !this.onResultCallback) {
            void onResult(result);
          }
        });
      },
      this.isAgentModeEnabled,
      this.getRecordingActivationMode
    );
  }

  stopKeyboardHook(): void {
    this.keyboardHook.stop();
  }

  start(): void {
    ipcMain.on('audio-window-ready', this.handleAudioWindowReady);
    ipcMain.on('audio-stream-ready', this.handleAudioStreamReady);
    ipcMain.on('audio-data-ready', this.handleAudioDataReady);
    ipcMain.on('audio-level-changed', this.handleAudioLevelChanged);

    this.startKeyboardHook();
  }

  stop(): void {
    this.clearDurationTimers();
    ipcMain.off('audio-window-ready', this.handleAudioWindowReady);
    ipcMain.off('audio-stream-ready', this.handleAudioStreamReady);
    ipcMain.off('audio-data-ready', this.handleAudioDataReady);
    ipcMain.off('audio-level-changed', this.handleAudioLevelChanged);

    this.stopKeyboardHook();
    this.audioCapture.destroy?.();
  }

  updateDevice(deviceId: string | null): void {
    this.audioCapture.setSelectedDevice(deviceId);
  }

  getAudioWebContents(): import('electron').WebContents | null {
    return this.audioCapture.getWebContents?.() ?? null;
  }

  private scheduleDurationLimit(maxDurationSeconds: number | null): void {
    this.clearDurationTimers();
    if (!maxDurationSeconds) return;
    const warningSeconds = Math.min(10, maxDurationSeconds);
    const warningStart = maxDurationSeconds - warningSeconds;
    for (let elapsed = warningStart; elapsed < maxDurationSeconds; elapsed++) {
      const remaining = maxDurationSeconds - elapsed;
      this.durationTimers.push(this.setTimeoutFn(() => {
        if (this.activeIntent) this.updateDurationWarningFn(remaining);
      }, elapsed * 1000));
    }
    this.durationTimers.push(this.setTimeoutFn(() => {
      if (!this.activeIntent) return;
      this.keyboardHook.recordingEndedExternally?.();
      void this.end().catch(() => undefined);
    }, maxDurationSeconds * 1000));
  }

  private clearDurationTimers(): void {
    for (const timer of this.durationTimers) this.clearTimeoutFn(timer);
    this.durationTimers = [];
    this.updateDurationWarningFn(null);
  }

  private handleAudioWindowReady = (): void => {
    this.audioCapture.prepare();
  };

  private handleAudioStreamReady = (): void => {
    this.audioCapture.markReady?.();
  };

  private handleAudioDataReady = async (_event: unknown, audioData: ArrayBuffer): Promise<void> => {
    const data = new Uint8Array(audioData);
    console.log(`Audio data ready: ${data.byteLength} bytes`);
    await this.complete(data);
  };

  private handleAudioLevelChanged = (_event: unknown, level: number): void => {
    const pill = getRecordingPillWindow();
    if (pill && !pill.isDestroyed()) {
      pill.webContents.send('audio:level-changed', level);
    }
  };
}


