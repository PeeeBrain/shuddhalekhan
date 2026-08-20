import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type {
  DictationMode,
  DictationTargetSnapshot,
  RecordingActivationMode,
  RecordingIntent,
  RecordingPresentationEnvelope,
  ShortcutBinding,
} from '../types/ipc';
import {
  createRecordingPresentationEnvelope,
  getTranscriptionTransportCapabilities,
  parseMaintainerRuntimeGates,
  type MaintainerRuntimeGates,
} from '../shared/dictation-runtime';
import { keyboardHook } from './native/keyboard';
import { DEFAULT_SHORTCUTS } from '../shared/shortcut-bindings';
import { captureForegroundTarget } from './native/target';
import {
  getRecordingPillWindow,
  hideRecordingPill,
  prepareRecordingPillWindow,
  showRecordingPill,
  updateRecordingDurationWarning,
} from './recording-pill';
import { localWhisperCppTranscriber } from './whisper';
import {
  TranscriptionFailure,
  type RecognitionSettings,
  type StreamingTranscriptionSession,
  type Transcriber,
} from './transcription';
import { createStreamingTranscriptLedger, type StreamingTranscriptLedger } from './streaming-transcript';
import { LiveDictationController } from './live-dictation-controller';
import { sendUnicodeText } from './native/unicode-input';
import { LIVE_KEYBOARD_RELEASE_GRACE_MS } from '../shared/live-dictation';
import { createSingletonWindow } from './window-factory';
import { emitPerformanceMarker } from './performance/marker-collector';
import { RuntimeShell } from './runtime-shell';

export interface RecordingResult {
  text: string;
  intent: RecordingIntent;
  targetSnapshot: DictationTargetSnapshot | null;
  recordingSessionId: string;
  sequence: number;
  revision: number;
  capabilities: RecordingPresentationEnvelope['capabilities'];
  outcome: NonNullable<RecordingPresentationEnvelope['outcome']>;
  liveDictation?: {
    halted: boolean;
    uncertain: boolean;
    hasAcceptedEvents: boolean;
    dispatchedProjectedLength: number;
    rawCommitted: string;
  };
}

export interface AudioCapture {
  prepare(): void;
  beginCapture(envelope?: RecordingPresentationEnvelope): void;
  endCapture(): boolean | void;
  cancelCapture(): void;
  setSelectedDevice(deviceId: string | null): void;
  destroy?(): void;
  markReady?(): void;
  markCrashed?(reason: string): void;
  getWebContents?(): import('electron').WebContents | null;
}

export interface RuntimeShellBackend extends AudioCapture {
  show(
    intent: RecordingIntent,
    recordingSessionId?: string,
    envelope?: RecordingPresentationEnvelope,
  ): void;
  hide(): void;
  showProcessing(recordingSessionId: string): void;
  showFailure(
    recordingSessionId: string | null,
    message: string,
    recoveryActions?: import('../types/ipc').DictationRecoveryAction[],
  ): void;
  finish(): void;
  updateDurationWarning(remainingSeconds: number | null): void;
  updateAudioLevel(level: number): void;
  showStreamingPreview?(recordingSessionId: string, committed: string, tentative: string): void;
  showInsertionHalted?(recordingSessionId: string): void;
  acceptsAudioEvent?(generation: number, recordingSessionId: string, sequence: number): boolean;
  consumeAudioEvent(generation: number, recordingSessionId: string, sequence: number): boolean;
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

  endCapture(): boolean {
    this.pendingBegin = false;
    const win = this.windowController.get();
    if (win && !win.isDestroyed()) {
      win.webContents.send('audio:stop-recording');
      return true;
    }
    return false;
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
  start(options: {
    onStart: (intent: RecordingIntent) => boolean | void;
    onStop: () => void;
    isAgentModeEnabled?: () => boolean;
    getBinding?: (intent: RecordingIntent) => ShortcutBinding | null;
    getActivationMode?: (intent: RecordingIntent) => RecordingActivationMode;
  }): void;
  stop(): void;
  recordingEndedExternally?(): void;
  isKeyboardClear?(): boolean;
  setKeyboardStateListener?(listener: (() => void) | null): void;
}

export interface RecordingSessionOptions {
  isAgentModeEnabled: () => boolean;
  getRecordingActivationMode?: (intent: RecordingIntent) => RecordingActivationMode;
  getShortcutBinding?: (intent: RecordingIntent) => ShortcutBinding | null;
  getSelectedDeviceId?: () => string | null;
  getRecognitionSettings?: () => RecognitionSettings;
  getDictationMode?: () => DictationMode;
  getReadinessError?: () => Error | null;
  onResult?: (result: RecordingResult | null) => void | Promise<void>;
  onError?: (error: Error) => void;

  audioCapture?: AudioCapture;
  runtimeShell?: RuntimeShellBackend;
  runtimeGates?: MaintainerRuntimeGates;
  keyboardHook?: KeyboardHook;
  transcriber?: Transcriber;
  getTranscriber?: () => Transcriber;
  captureTarget?: () => DictationTargetSnapshot | null;
  showRecordingPill?: (
    intent: RecordingIntent,
    recordingSessionId?: string,
    envelope?: RecordingPresentationEnvelope,
  ) => void;
  hideRecordingPill?: () => void;
  updateDurationWarning?: (remainingSeconds: number | null) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

interface RecordingRunContext {
  id: string;
  intent: RecordingIntent;
  transcriber: Transcriber;
  targetSnapshot: DictationTargetSnapshot | null;
  sequence: number;
  revision: number;
  state: 'recording' | 'stopping' | 'transcribing';
  pendingEnd: {
    resolve: (result: RecordingResult | null) => void;
    reject: (error: unknown) => void;
  } | null;
  streaming: {
    session: StreamingTranscriptionSession;
    ledger: StreamingTranscriptLedger;
    queue: Promise<void>;
    expectedChunkSequence: number;
    failed: boolean;
    liveInsertion: LiveDictationController | null;
  } | null;
}

export class RecordingSession {
  private activeRun: RecordingRunContext | null = null;

  private isAgentModeEnabled: () => boolean;
  private getRecordingActivationMode: (intent: RecordingIntent) => RecordingActivationMode;
  private getShortcutBinding: (intent: RecordingIntent) => ShortcutBinding | null;
  private audioCapture: AudioCapture;
  private keyboardHook: KeyboardHook;
  private getTranscriber: () => Transcriber;
  private getRecognitionSettings: () => RecognitionSettings;
  private getDictationMode: () => DictationMode;
  private getReadinessError: () => Error | null;
  private captureTarget: () => DictationTargetSnapshot | null;
  private showRecordingPillFn: (
    intent: RecordingIntent,
    recordingSessionId?: string,
    envelope?: RecordingPresentationEnvelope,
  ) => void;
  private hideRecordingPillFn: () => void;
  private updateDurationWarningFn: (remainingSeconds: number | null) => void;
  private preparePresentationFn: () => void;
  private updateAudioLevelFn: (level: number) => void;
  private showProcessingFn: ((recordingSessionId: string) => void) | null;
  private finishPresentationFn: (() => void) | null;
  private showFailureFn: ((recordingSessionId: string | null, message: string) => void) | null;
  private runtimeShellBackend: RuntimeShellBackend | null;
  private streamingEnabled: boolean;
  private setTimeoutFn: typeof setTimeout;
  private clearTimeoutFn: typeof clearTimeout;
  private durationTimers: Array<ReturnType<typeof setTimeout>> = [];
  private onResultCallback?: (result: RecordingResult | null) => void | Promise<void>;
  private onErrorCallback?: (error: Error) => void;
  private getSelectedDeviceId?: () => string | null;

  constructor(options: RecordingSessionOptions) {
    this.isAgentModeEnabled = options.isAgentModeEnabled;
    this.getRecordingActivationMode = options.getRecordingActivationMode ?? (() => 'push-to-talk');
    this.getShortcutBinding = options.getShortcutBinding ?? ((intent) => DEFAULT_SHORTCUTS[intent].binding);
    const runtimeGates = options.runtimeGates ?? parseMaintainerRuntimeGates(process.env);
    const useRuntimeShell = runtimeGates.runtimeShell && !options.audioCapture;
    this.streamingEnabled = runtimeGates.streaming;
    const runtimeShell = useRuntimeShell
      ? options.runtimeShell ?? new RuntimeShell((reason) => this.handleAudioRendererCrash(reason))
      : null;
    this.audioCapture = options.audioCapture ?? runtimeShell ?? new ProductionAudioCapture(
      (reason) => this.handleAudioRendererCrash(reason)
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
    this.getDictationMode = options.getDictationMode ?? (() => 'batch');
    this.getReadinessError = options.getReadinessError ?? (() => null);
    this.captureTarget = options.captureTarget ?? captureForegroundTarget;
    this.showRecordingPillFn = options.showRecordingPill
      ?? (runtimeShell ? runtimeShell.show.bind(runtimeShell) : showRecordingPill);
    this.hideRecordingPillFn = options.hideRecordingPill
      ?? (runtimeShell ? runtimeShell.hide.bind(runtimeShell) : hideRecordingPill);
    this.updateDurationWarningFn = options.updateDurationWarning
      ?? (runtimeShell
        ? runtimeShell.updateDurationWarning.bind(runtimeShell)
        : updateRecordingDurationWarning);
    this.preparePresentationFn = runtimeShell
      ? runtimeShell.prepare.bind(runtimeShell)
      : prepareRecordingPillWindow;
    this.updateAudioLevelFn = runtimeShell
      ? runtimeShell.updateAudioLevel.bind(runtimeShell)
      : (level) => {
          const pill = getRecordingPillWindow();
          if (pill && !pill.isDestroyed()) pill.webContents.send('audio:level-changed', level);
        };
    this.showProcessingFn = runtimeShell ? runtimeShell.showProcessing.bind(runtimeShell) : null;
    this.finishPresentationFn = runtimeShell ? runtimeShell.finish.bind(runtimeShell) : null;
    this.showFailureFn = runtimeShell ? runtimeShell.showFailure.bind(runtimeShell) : null;
    this.runtimeShellBackend = runtimeShell;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.onResultCallback = options.onResult;
    this.onErrorCallback = options.onError;
    this.getSelectedDeviceId = options.getSelectedDeviceId;
  }

  begin(intent: RecordingIntent = 'dictation', recordingSessionId: string = randomUUID()): boolean {
    if (this.activeRun !== null) {
      emitPerformanceMarker('recording.begin.rejected', {
        recordingSessionId,
        surface: intent,
        reason: 'busy',
      });
      return false;
    }
    const readinessError = this.getReadinessError();
    if (readinessError) {
      emitPerformanceMarker('recording.begin.rejected', {
        recordingSessionId,
        surface: intent,
        reason: 'not-ready',
      });
      this.onErrorCallback?.(readinessError);
      return false;
    }
    const targetSnapshot = this.captureTarget();
    if (intent === 'dictation' && this.getDictationMode() === 'live') {
      if (this.getRecordingActivationMode('dictation') !== 'toggle') {
        const error = new Error('Live Dictation requires Toggle activation.');
        emitPerformanceMarker('recording.begin.rejected', {
          recordingSessionId,
          surface: intent,
          reason: 'live-activation',
        });
        this.onErrorCallback?.(error);
        return false;
      }
      if (!targetSnapshot) {
        const error = new Error('Live Dictation requires a focused target application.');
        emitPerformanceMarker('recording.begin.rejected', {
          recordingSessionId,
          surface: intent,
          reason: 'no-target',
        });
        this.onErrorCallback?.(error);
        return false;
      }
    }
    const transcriber = this.getTranscriber();
    const run: RecordingRunContext = {
      id: recordingSessionId,
      intent,
      transcriber,
      targetSnapshot,
      sequence: 0,
      revision: 0,
      state: 'recording',
      pendingEnd: null,
      streaming: null,
    };
    this.activeRun = run;
    this.startStreamingIfEligible(run);

    emitPerformanceMarker('recording.begin.accepted', {
      recordingSessionId: run.id,
      surface: intent,
    });

    const deviceId = this.getSelectedDeviceId?.();
    console.log(`Starting recording session. Device: ${deviceId ?? 'default'}`);

    const presentation = this.createPresentationEnvelope(run);
    this.audioCapture.prepare();
    this.audioCapture.beginCapture(presentation);
    this.showRecordingPillFn(
      intent,
      run.id,
      presentation,
    );
    this.scheduleDurationLimit(transcriber.capabilities.maxDurationSeconds);
    return true;
  }

  async end(): Promise<RecordingResult | null> {
    const run = this.activeRun;
    if (!run || run.state !== 'recording') return null;

    emitPerformanceMarker('recording.stop.requested', {
      recordingSessionId: run.id,
    });
    this.clearDurationTimers();
    run.state = 'stopping';
    if (this.showProcessingFn) {
      this.showProcessingFn(run.id);
    } else {
      this.hideRecordingPillFn();
    }
    return new Promise((resolve, reject) => {
      run.pendingEnd = { resolve, reject };
      if (this.audioCapture.endCapture() === false) {
        run.pendingEnd = null;
        this.finishPresentationFn?.();
        if (this.activeRun === run) this.activeRun = null;
        resolve(null);
      }
    });
  }

  async cancel(): Promise<void> {
    this.clearDurationTimers();
    const run = this.activeRun;
    this.hideRecordingPillFn();
    this.finishPresentationFn?.();
    this.audioCapture.cancelCapture();
    if (run) {
      run.streaming?.liveInsertion?.invalidate();
      run.streaming?.session.cancel();
      run.pendingEnd?.resolve(null);
      this.activeRun = null;
    }
  }

  /** Runs the pinned benchmark audio through the normal batch transcription path without using the live microphone. */
  async runPerformanceFixture(
    audioData: Uint8Array,
    playbackDurationMs: number,
    transcriber: Transcriber,
  ): Promise<RecordingResult | null> {
    const recordingSessionId = randomUUID();
    emitPerformanceMarker('hotkey.detected', { recordingSessionId, surface: 'dictation' });
    if (this.activeRun !== null) {
      emitPerformanceMarker('recording.begin.rejected', {
        recordingSessionId,
        surface: 'dictation',
        reason: 'busy',
      });
      return null;
    }

    const run: RecordingRunContext = {
      id: recordingSessionId,
      intent: 'dictation',
      transcriber,
      targetSnapshot: null,
      sequence: 0,
      revision: 0,
      state: 'recording',
      pendingEnd: null,
      streaming: null,
    };
    this.activeRun = run;

    emitPerformanceMarker('recording.begin.accepted', {
      recordingSessionId,
      surface: 'dictation',
    });
    this.audioCapture.prepare();
    this.showRecordingPillFn(
      'dictation',
      recordingSessionId,
      this.createPresentationEnvelope(run, transcriber),
    );
    emitPerformanceMarker('audio.capture.started', {
      recordingSessionId,
      surface: 'dictation',
      source: 'fixture',
    });

    if (playbackDurationMs > 0) {
      await new Promise<void>((resolve) => this.setTimeoutFn(resolve, playbackDurationMs));
    }
    emitPerformanceMarker('recording.stop.requested', { recordingSessionId });
    this.hideRecordingPillFn();
    return this.complete(audioData, transcriber, false);
  }

  isActive(): boolean {
    return this.activeRun !== null && this.activeRun.state === 'recording';
  }

  markAudioWindowReady(): void {
    this.audioCapture.markReady?.();
  }

  markAudioWindowCrashed(reason: string): void {
    this.audioCapture.markCrashed?.(reason);
    this.handleAudioRendererCrash(reason);
  }

  markRuntimeShellCrashed(reason: string): void {
    this.handleAudioRendererCrash(reason);
  }

  private handleAudioRendererCrash(reason: string): void {
    const error = new Error(`Audio window crashed: ${reason}`);
    this.clearDurationTimers();
    const run = this.activeRun;
    this.hideRecordingPillFn();
    if (run) {
      run.streaming?.session.cancel();
      run.pendingEnd?.reject(error);
      this.activeRun = null;
    }
    this.onErrorCallback?.(error);
  }

  async complete(
    audioData: Uint8Array,
    transcriberOverride?: Transcriber,
    notifyResult = true,
  ): Promise<RecordingResult | null> {
    const run = this.activeRun;
    if (!run) {
      audioData.fill(0);
      return null;
    }
    run.state = 'transcribing';
    const pendingEnd = run.pendingEnd;
    const intent = run.intent;

    if (audioData.byteLength <= 44) {
      console.warn(`Skipping empty WAV payload: ${audioData.byteLength} bytes`);
      const error = new TranscriptionFailure(
        'unknown',
        'No microphone audio was captured. Check the selected input device and try again.',
      );
      run.streaming?.session.cancel();
      run.streaming = null;
      audioData.fill(0);
      pendingEnd?.reject(error);
      if (this.onErrorCallback) this.onErrorCallback(error);
      else this.showFailureFn?.(run.id, error.message);
      this.activeRun = null;
      return null;
    }

    try {
      const transcriber = transcriberOverride ?? run.transcriber;
      const text = await this.transcribeCompletedAudio(run, transcriber, audioData);
      if (text === null || this.activeRun !== run) return null;
      const snapshot = run.targetSnapshot;
      const liveState = run.streaming?.liveInsertion?.getState();
      const envelope = this.createPresentationEnvelope(run, transcriber, { kind: 'completed' });
      const result = text ? {
        text,
        intent,
        targetSnapshot: snapshot,
        recordingSessionId: envelope.recordingSessionId,
        sequence: envelope.sequence,
        revision: envelope.revision,
        capabilities: envelope.capabilities,
        outcome: envelope.outcome ?? { kind: 'completed' },
        ...(liveState ? {
          liveDictation: {
            halted: liveState.halted,
            uncertain: liveState.uncertain,
            hasAcceptedEvents: liveState.hasAcceptedEvents,
            dispatchedProjectedLength: liveState.dispatchedProjectedLength,
            rawCommitted: liveState.rawCommitted,
          },
        } : {}),
      } : null;
      this.keyboardHook.setKeyboardStateListener?.(null);
      this.finishPresentationFn?.();
      emitPerformanceMarker('recording.session.completed', {
        recordingSessionId: run.id,
        surface: intent,
      });
      pendingEnd?.resolve(result);
      if (notifyResult && this.onResultCallback) {
        void this.onResultCallback(result);
      }
      return result;
    } catch (error) {
      if (this.activeRun !== run) return null;
      const err = error instanceof Error ? error : new Error(String(error));
      emitPerformanceMarker('transcription.batch.failed', {
        recordingSessionId: run.id,
        surface: intent,
      });
      pendingEnd?.reject(err);
      if (this.onErrorCallback) this.onErrorCallback(err);
      else this.showFailureFn?.(run.id, 'Transcription failed.');
      if (!pendingEnd) {
        throw err;
      }
      return null;
    } finally {
      audioData.fill(0);
      if (this.activeRun === run) {
        this.activeRun = null;
      }
    }
  }

  startKeyboardHook(onResult?: (result: RecordingResult | null) => void | Promise<void>): void {
    this.keyboardHook.start({
      onStart: (intent) => {
        const recordingSessionId = randomUUID();
        emitPerformanceMarker('hotkey.detected', { recordingSessionId, surface: intent });
        return this.begin(intent, recordingSessionId);
      },
      onStop: () => {
        void this.end().then((result) => {
          if (onResult && !this.onResultCallback) {
            void onResult(result);
          }
        }).catch(() => undefined);
      },
      isAgentModeEnabled: this.isAgentModeEnabled,
      getBinding: this.getShortcutBinding,
      getActivationMode: this.getRecordingActivationMode,
    });
  }

  stopKeyboardHook(): void {
    this.keyboardHook.stop();
  }

  start(): void {
    // Prewarm the hidden renderer before installing the global hook. Audio can
    // still start immediately if the user invokes a shortcut during loading.
    this.preparePresentationFn();

    ipcMain.on('audio-window-ready', this.handleAudioWindowReady);
    ipcMain.on('audio-stream-ready', this.handleAudioStreamReady);
    ipcMain.on('audio-capture-started', this.handleAudioCaptureStarted);
    ipcMain.on('audio-capture-failed', this.handleAudioCaptureFailed);
    ipcMain.on('audio-data-ready', this.handleAudioDataReady);
    ipcMain.on('runtime:audio-chunk', this.handleRuntimeAudioChunk);
    ipcMain.on('runtime:audio-stream-disabled', this.handleRuntimeAudioStreamDisabled);
    ipcMain.on('runtime:audio-data-ready', this.handleRuntimeAudioDataReady);
    ipcMain.on('runtime:audio-failed', this.handleRuntimeAudioFailed);
    ipcMain.on('audio-level-changed', this.handleAudioLevelChanged);

    this.startKeyboardHook();
  }

  stop(): void {
    this.clearDurationTimers();
    ipcMain.off('audio-window-ready', this.handleAudioWindowReady);
    ipcMain.off('audio-stream-ready', this.handleAudioStreamReady);
    ipcMain.off('audio-capture-started', this.handleAudioCaptureStarted);
    ipcMain.off('audio-capture-failed', this.handleAudioCaptureFailed);
    ipcMain.off('audio-data-ready', this.handleAudioDataReady);
    ipcMain.off('runtime:audio-chunk', this.handleRuntimeAudioChunk);
    ipcMain.off('runtime:audio-stream-disabled', this.handleRuntimeAudioStreamDisabled);
    ipcMain.off('runtime:audio-data-ready', this.handleRuntimeAudioDataReady);
    ipcMain.off('runtime:audio-failed', this.handleRuntimeAudioFailed);
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

  private startStreamingIfEligible(run: RecordingRunContext): void {
    if (
      !this.streamingEnabled
      || !this.runtimeShellBackend
      || !run.transcriber.startStreaming
      || (run.intent === 'dictation' && (
        this.getDictationMode() !== 'live'
        || this.getRecordingActivationMode('dictation') !== 'toggle'
      ))
    ) return;

    const ledger = createStreamingTranscriptLedger();
    const liveInsertion = run.intent === 'dictation' && this.getDictationMode() === 'live' && run.targetSnapshot
      ? new LiveDictationController({
          originalTarget: run.targetSnapshot,
          captureTarget: this.captureTarget,
          isKeyboardClear: () => this.keyboardHook.isKeyboardClear?.() ?? true,
          dispatchUnicode: sendUnicodeText,
          onHalted: () => {
            this.runtimeShellBackend?.showInsertionHalted?.(run.id);
          },
        })
      : null;
    try {
      const session = run.transcriber.startStreaming({
        recognition: this.getRecognitionSettings(),
        onSnapshot: (snapshot) => {
          if (this.activeRun !== run) return;
          const update = ledger.apply(snapshot);
          if (update.kind === 'protocol-failure') {
            liveInsertion?.haltForReason('prefix-violation');
            this.disableStreaming(run);
            return;
          }
          void liveInsertion?.onCommittedUpdate(update.committed);
          this.runtimeShellBackend?.showStreamingPreview?.(
            run.id,
            update.committed,
            update.tentative,
          );
        },
      });
      run.streaming = {
        session,
        ledger,
        queue: Promise.resolve(),
        expectedChunkSequence: 0,
        failed: false,
        liveInsertion,
      };
      if (liveInsertion) {
        this.keyboardHook.setKeyboardStateListener?.(() => {
          if (this.activeRun !== run) return;
          void liveInsertion.onKeyboardStateChanged();
        });
      }
    } catch {
      run.streaming = null;
    }
  }

  private disableStreaming(run: RecordingRunContext): void {
    if (!run.streaming || run.streaming.failed) return;
    run.streaming.failed = true;
    const liveInsertion = run.streaming.liveInsertion;
    if (liveInsertion && !liveInsertion.getState().halted) {
      liveInsertion.haltForReason('session-invalidated');
    }
    run.streaming.session.cancel();
    this.keyboardHook.setKeyboardStateListener?.(null);
  }

  private async transcribeCompletedAudio(
    run: RecordingRunContext,
    transcriber: Transcriber,
    audioData: Uint8Array,
  ): Promise<string | null> {
    const streaming = run.streaming;
    if (streaming) {
      await streaming.queue;
      if (this.activeRun !== run) return null;
      if (!streaming.failed) {
        try {
          const providerFinal = await streaming.session.finish();
          if (this.activeRun !== run) return null;
          const acceptedFinal = streaming.ledger.finalize();
          if (providerFinal !== acceptedFinal) {
            throw new TranscriptionFailure(
              'malformed-response',
              'WhisperLiveKit finalized a transcript that was not committed.',
            );
          }
          if (streaming.liveInsertion) {
            const keyboardClear = await this.waitForKeyboardClear(LIVE_KEYBOARD_RELEASE_GRACE_MS);
            if (this.activeRun !== run) return null;
            if (!keyboardClear) {
              streaming.liveInsertion.haltForReason('keyboard-timeout');
            } else if (this.activeRun === run) {
              await streaming.liveInsertion.finalize(acceptedFinal);
              if (this.activeRun !== run) return null;
            }
          }
          emitPerformanceMarker('transcription.streaming.completed', {
            recordingSessionId: run.id,
            surface: run.intent,
          });
          return acceptedFinal;
        } catch {
          if (this.activeRun !== run) return null;
          this.disableStreaming(run);
        }
      }
    }

    if (this.activeRun !== run) return null;
    emitPerformanceMarker('transcription.batch.requested', {
      recordingSessionId: run.id,
      surface: run.intent,
    });
    const text = await transcriber.transcribe({
      audio: audioData,
      recognition: this.getRecognitionSettings(),
    });
    if (this.activeRun !== run) return null;
    emitPerformanceMarker('transcription.batch.completed', {
      recordingSessionId: run.id,
      surface: run.intent,
    });
    return text;
  }

  private createPresentationEnvelope(
    run: RecordingRunContext,
    transcriber: Transcriber = run.transcriber,
    outcome?: import('../types/ipc').RecordingTerminalOutcome,
  ): RecordingPresentationEnvelope {
    run.sequence += 1;
    run.revision += 1;
    return createRecordingPresentationEnvelope({
      recordingSessionId: run.id,
      sequence: run.sequence,
      revision: run.revision,
      capabilities: transcriber.transportCapabilities
        ?? getTranscriptionTransportCapabilities(transcriber.id),
      streamingActive: run.streaming !== null && !run.streaming.failed,
      outcome,
    });
  }

  private scheduleDurationLimit(maxDurationSeconds: number | null): void {
    this.clearDurationTimers();
    if (!maxDurationSeconds) return;
    const warningSeconds = Math.min(10, maxDurationSeconds);
    const warningStart = maxDurationSeconds - warningSeconds;
    for (let elapsed = warningStart; elapsed < maxDurationSeconds; elapsed++) {
      const remaining = maxDurationSeconds - elapsed;
      this.durationTimers.push(this.setTimeoutFn(() => {
        if (this.activeRun?.state === 'recording') this.updateDurationWarningFn(remaining);
      }, elapsed * 1000));
    }
    this.durationTimers.push(this.setTimeoutFn(() => {
      if (this.activeRun?.state !== 'recording') return;
      this.keyboardHook.recordingEndedExternally?.();
      void this.end().catch(() => undefined);
    }, maxDurationSeconds * 1000));
  }

  private clearDurationTimers(): void {
    for (const timer of this.durationTimers) this.clearTimeoutFn(timer);
    this.durationTimers = [];
    this.updateDurationWarningFn(null);
  }

  private async waitForKeyboardClear(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.keyboardHook.isKeyboardClear?.()) return true;
      await new Promise<void>((resolve) => {
        this.setTimeoutFn(resolve, 50);
      });
    }
    return this.keyboardHook.isKeyboardClear?.() ?? false;
  }

  private handleAudioWindowReady = (): void => {
    this.audioCapture.prepare();
  };

  private handleAudioStreamReady = (): void => {
    emitPerformanceMarker('audio-stream.ready', {
      recordingSessionId: this.activeRun?.id,
    });
    this.audioCapture.markReady?.();
  };

  private handleAudioCaptureStarted = (): void => {
    if (!this.activeRun) return;
    emitPerformanceMarker('audio.capture.started', {
      recordingSessionId: this.activeRun.id,
      surface: this.activeRun.intent,
    });
  };

  private handleAudioCaptureFailed = (): void => {
    this.failActiveCapture();
  };

  private handleAudioDataReady = async (_event: unknown, audioData: ArrayBuffer): Promise<void> => {
    const data = new Uint8Array(audioData);
    console.log(`Audio data ready: ${data.byteLength} bytes`);
    try {
      await this.complete(data);
    } catch {
      // Defensively catch in async ipcMain.on listener
    }
  };

  private handleRuntimeAudioChunk = async (
    _event: unknown,
    generation: number,
    recordingSessionId: string,
    commandSequence: number,
    chunkSequence: number,
    audioData: ArrayBuffer,
  ): Promise<void> => {
    const pcm = new Uint8Array(audioData);
    const run = this.activeRun;
    const streaming = run?.streaming;
    const acceptedIdentity = this.runtimeShellBackend?.acceptsAudioEvent
      ? this.runtimeShellBackend.acceptsAudioEvent(generation, recordingSessionId, commandSequence)
      : run?.id === recordingSessionId && run.sequence === commandSequence;
    if (!run || !streaming || !acceptedIdentity || chunkSequence !== streaming.expectedChunkSequence) {
      pcm.fill(0);
      if (streaming && run?.id === recordingSessionId) this.disableStreaming(run);
      return;
    }
    streaming.expectedChunkSequence += 1;
    const send = streaming.queue.then(async () => {
      if (streaming.failed) return;
      try {
        await streaming.session.send(pcm);
        if (this.activeRun === run && !streaming.failed) {
          this.audioCapture.getWebContents?.()?.send(
            'runtime:audio-chunk-accepted',
            generation,
            recordingSessionId,
            commandSequence,
            chunkSequence,
          );
        }
      } catch {
        this.disableStreaming(run);
      } finally {
        pcm.fill(0);
      }
    });
    streaming.queue = send;
    await send;
  };

  private handleRuntimeAudioStreamDisabled = (
    _event: unknown,
    generation: number,
    recordingSessionId: string,
    commandSequence: number,
  ): void => {
    const run = this.activeRun;
    if (!run?.streaming) return;
    const acceptedIdentity = this.runtimeShellBackend?.acceptsAudioEvent
      ? this.runtimeShellBackend.acceptsAudioEvent(generation, recordingSessionId, commandSequence)
      : run.id === recordingSessionId && run.sequence === commandSequence;
    if (acceptedIdentity) this.disableStreaming(run);
  };

  private handleRuntimeAudioDataReady = async (
    _event: unknown,
    generation: number,
    recordingSessionId: string,
    sequence: number,
    audioData: ArrayBuffer,
  ): Promise<void> => {
    const data = new Uint8Array(audioData);
    if (!this.runtimeShellBackend?.consumeAudioEvent(generation, recordingSessionId, sequence)) {
      data.fill(0);
      return;
    }
    try {
      await this.complete(data);
    } catch {
      // Defensively catch in async ipcMain.on listener
    }
  };

  private handleRuntimeAudioFailed = (
    _event: unknown,
    generation: number,
    recordingSessionId: string,
    sequence: number,
  ): void => {
    if (!this.runtimeShellBackend?.consumeAudioEvent(generation, recordingSessionId, sequence)) return;
    this.failActiveCapture();
  };

  private failActiveCapture(): void {
    const run = this.activeRun;
    if (!run) return;
    run.streaming?.session.cancel();
    const error = new TranscriptionFailure(
      'unknown',
      'Microphone capture failed. Check the selected input device and try again.',
    );
    this.clearDurationTimers();
    this.keyboardHook.recordingEndedExternally?.();
    run.pendingEnd?.reject(error);
    if (this.onErrorCallback) this.onErrorCallback(error);
    else this.showFailureFn?.(run.id, error.message);
    if (this.activeRun === run) this.activeRun = null;
  }

  private handleAudioLevelChanged = (_event: unknown, level: number): void => {
    this.updateAudioLevelFn(level);
  };
}


