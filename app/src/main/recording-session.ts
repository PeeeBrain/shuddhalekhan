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
} from '../shared/dictation-runtime';
import { keyboardHook } from './native/keyboard';
import { DEFAULT_SHORTCUTS } from '../shared/shortcut-bindings';
import { captureForegroundTarget } from './native/target';
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
  getReadinessError?: (intent: RecordingIntent) => Error | null;
  onResult?: (result: RecordingResult | null) => void | Promise<void>;
  onError?: (error: Error) => void;
  onBegin?: (intent: RecordingIntent) => void;
  onFirstAudioBuffer?: (transcriber: Transcriber) => void;

  runtimeShell?: RuntimeShellBackend;
  keyboardHook?: KeyboardHook;
  transcriber?: Transcriber;
  getTranscriber?: () => Transcriber;
  captureTarget?: () => DictationTargetSnapshot | null;
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
    /** Null for incremental sessions, whose finish() is the transcript without live snapshots. */
    ledger: StreamingTranscriptLedger | null;
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
  private getReadinessError: (intent: RecordingIntent) => Error | null;
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
  private setTimeoutFn: typeof setTimeout;
  private clearTimeoutFn: typeof clearTimeout;
  private durationTimers: Array<ReturnType<typeof setTimeout>> = [];
  private onResultCallback?: (result: RecordingResult | null) => void | Promise<void>;
  private onErrorCallback?: (error: Error) => void;
  private onBeginCallback?: (intent: RecordingIntent) => void;
  private onFirstAudioBufferCallback?: (transcriber: Transcriber) => void;
  private getSelectedDeviceId?: () => string | null;

  constructor(options: RecordingSessionOptions) {
    this.isAgentModeEnabled = options.isAgentModeEnabled;
    this.getRecordingActivationMode = options.getRecordingActivationMode ?? (() => 'push-to-talk');
    this.getShortcutBinding = options.getShortcutBinding ?? ((intent) => DEFAULT_SHORTCUTS[intent].binding);
    const runtimeShell = options.runtimeShell
      ?? new RuntimeShell((reason) => this.handleAudioRendererCrash(reason));
    this.audioCapture = runtimeShell;
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
    this.showRecordingPillFn = runtimeShell.show.bind(runtimeShell);
    this.hideRecordingPillFn = runtimeShell.hide.bind(runtimeShell);
    this.updateDurationWarningFn = runtimeShell.updateDurationWarning.bind(runtimeShell);
    this.preparePresentationFn = runtimeShell.prepare.bind(runtimeShell);
    this.updateAudioLevelFn = runtimeShell.updateAudioLevel.bind(runtimeShell);
    this.showProcessingFn = runtimeShell.showProcessing.bind(runtimeShell);
    this.finishPresentationFn = runtimeShell.finish.bind(runtimeShell);
    this.showFailureFn = runtimeShell.showFailure.bind(runtimeShell);
    this.runtimeShellBackend = runtimeShell;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.onResultCallback = options.onResult;
    this.onErrorCallback = options.onError;
    this.onBeginCallback = options.onBegin;
    this.onFirstAudioBufferCallback = options.onFirstAudioBuffer;
    this.getSelectedDeviceId = options.getSelectedDeviceId;
  }

  begin(intent: RecordingIntent = 'dictation', recordingSessionId: string = randomUUID()): boolean {
    if (this.activeRun !== null) {
      return false;
    }
    const readinessError = this.getReadinessError(intent);
    if (readinessError) {
      this.onErrorCallback?.(readinessError);
      return false;
    }
    const targetSnapshot = this.captureTarget();
    const transcriber = this.getTranscriber();
    const liveDictationRequested = intent === 'dictation' && this.getDictationMode() === 'live';
    if (liveDictationRequested) {
      if (this.getRecordingActivationMode('dictation') !== 'toggle') {
        const error = new Error('Live Dictation requires Toggle activation.');
        this.onErrorCallback?.(error);
        return false;
      }
      if (!targetSnapshot) {
        const error = new Error('Live Dictation requires a focused target application.');
        this.onErrorCallback?.(error);
        return false;
      }
      if (!this.canStartLiveStreaming(transcriber)) {
        const error = new Error('Live Dictation requires a streaming-capable provider.');
        this.onErrorCallback?.(error);
        return false;
      }
    }
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
    const streamingStarted = this.startStreamingIfEligible(run);
    if (liveDictationRequested && !streamingStarted) {
      this.activeRun = null;
      const error = new Error('Live Dictation streaming could not start.');
      this.onErrorCallback?.(error);
      return false;
    }

    this.onBeginCallback?.(intent);

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
      this.teardownLiveDictation(run);
      run.pendingEnd?.resolve(null);
      this.activeRun = null;
    }
  }

  isActive(): boolean {
    return this.activeRun !== null && this.activeRun.state === 'recording';
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
      this.teardownLiveDictation(run);
      run.pendingEnd?.reject(error);
      this.activeRun = null;
    }
    this.onErrorCallback?.(error);
  }

  async complete(audioData: Uint8Array<ArrayBuffer>): Promise<RecordingResult | null> {
    const run = this.activeRun;
    if (!run) {
      audioData.fill(0);
      return null;
    }
    run.state = 'transcribing';
    const pendingEnd = run.pendingEnd;

    if (audioData.byteLength <= 44) {
      console.warn(`Skipping empty WAV payload: ${audioData.byteLength} bytes`);
      const error = new TranscriptionFailure(
        'unknown',
        'No microphone audio was captured. Check the selected input device and try again.',
      );
      this.teardownLiveDictation(run);
      run.streaming = null;
      audioData.fill(0);
      pendingEnd?.reject(error);
      if (this.onErrorCallback) this.onErrorCallback(error);
      else this.showFailureFn?.(run.id, error.message);
      this.activeRun = null;
      return null;
    }

    const transcriber = run.transcriber;
    try {
      const text = await this.transcribeCompletedAudio(run, transcriber, audioData);
      if (text === null || this.activeRun !== run) return null;
      const result = text
        ? this.createRecordingResult(run, transcriber, text, { kind: 'completed' })
        : null;
      this.keyboardHook.setKeyboardStateListener?.(null);
      this.finishPresentationFn?.();
      pendingEnd?.resolve(result);
      if (this.onResultCallback) {
        void this.onResultCallback(result);
      }
      return result;
    } catch (error) {
      if (this.activeRun !== run) return null;
      const err = error instanceof Error ? error : new Error(String(error));
      const recognizedSoFar = run.streaming?.liveInsertion?.getState().rawCommitted;
      if (recognizedSoFar) {
        const result = this.createRecordingResult(
          run,
          transcriber,
          recognizedSoFar,
          { kind: 'failed', message: err.message },
        );
        this.keyboardHook.setKeyboardStateListener?.(null);
        this.finishPresentationFn?.();
        pendingEnd?.resolve(result);
        if (this.onResultCallback) {
          void this.onResultCallback(result);
        }
        return result;
      }
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
        return this.begin(intent);
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

    ipcMain.on('audio-stream-ready', this.handleAudioStreamReady);
    ipcMain.on('runtime:audio-first-buffer', this.handleAudioFirstBuffer);
    ipcMain.on('runtime:audio-chunk', this.handleRuntimeAudioChunk);
    ipcMain.on('runtime:audio-stream-disabled', this.handleRuntimeAudioStreamDisabled);
    ipcMain.on('runtime:audio-data-ready', this.handleRuntimeAudioDataReady);
    ipcMain.on('runtime:audio-failed', this.handleRuntimeAudioFailed);
    ipcMain.on('audio-level-changed', this.handleAudioLevelChanged);

    this.startKeyboardHook();
  }

  stop(): void {
    this.clearDurationTimers();
    ipcMain.off('audio-stream-ready', this.handleAudioStreamReady);
    ipcMain.off('runtime:audio-first-buffer', this.handleAudioFirstBuffer);
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

  private canStartLiveStreaming(transcriber: Transcriber): boolean {
    return typeof transcriber.startStreaming === 'function';
  }

  private startIncrementalIfSupported(run: RecordingRunContext): void {
    const startIncremental = run.transcriber.startIncremental;
    if (!startIncremental) return;
    try {
      run.streaming = {
        session: startIncremental({ recognition: this.getRecognitionSettings() }),
        ledger: null,
        queue: Promise.resolve(),
        expectedChunkSequence: 0,
        failed: false,
        liveInsertion: null,
      };
    } catch {
      // The completed recording is still transcribed in one pass.
      run.streaming = null;
    }
  }

  private startStreamingIfEligible(run: RecordingRunContext): boolean {
    if (!this.canStartLiveStreaming(run.transcriber)) {
      this.startIncrementalIfSupported(run);
      return false;
    }
    if (run.intent === 'dictation' && (
      this.getDictationMode() !== 'live'
      || this.getRecordingActivationMode('dictation') !== 'toggle'
    )) return false;

    const startStreaming = run.transcriber.startStreaming;
    if (!startStreaming) return false;

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
      const session = startStreaming({
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
      return true;
    } catch {
      try {
        this.teardownLiveDictation(run);
      } catch {
        // Startup failure is reported by begin(); teardown remains best effort.
      }
      run.streaming = null;
      return false;
    }
  }

  private teardownLiveDictation(run: RecordingRunContext): void {
    if (!run.streaming) return;
    run.streaming.liveInsertion?.invalidate();
    run.streaming.session.cancel();
    this.keyboardHook.setKeyboardStateListener?.(null);
  }

  private disableStreaming(run: RecordingRunContext): void {
    if (!run.streaming || run.streaming.failed) return;
    run.streaming.failed = true;
    const liveInsertion = run.streaming.liveInsertion;
    if (liveInsertion && !liveInsertion.getState().halted) {
      liveInsertion.haltForReason('session-invalidated');
    }
    this.teardownLiveDictation(run);
  }

  private async transcribeCompletedAudio(
    run: RecordingRunContext,
    transcriber: Transcriber,
    audioData: Uint8Array<ArrayBuffer>,
  ): Promise<string | null> {
    const streaming = run.streaming;
    if (streaming) {
      await streaming.queue;
      if (this.activeRun !== run) return null;
      if (!streaming.failed) {
        try {
          const providerFinal = await streaming.session.finish();
          if (this.activeRun !== run) return null;
          if (!streaming.ledger) return providerFinal;
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
          return acceptedFinal;
        } catch {
          if (this.activeRun !== run) return null;
          this.disableStreaming(run);
        }
      }
    }

    if (this.activeRun !== run) return null;
    const text = await transcriber.transcribe({
      audio: audioData,
      recognition: this.getRecognitionSettings(),
    });
    if (this.activeRun !== run) return null;
    return text;
  }

  private createRecordingResult(
    run: RecordingRunContext,
    transcriber: Transcriber,
    text: string,
    outcome: RecordingResult['outcome'],
  ): RecordingResult {
    const liveState = run.streaming?.liveInsertion?.getState();
    const envelope = this.createPresentationEnvelope(run, transcriber, outcome);
    return {
      text,
      intent: run.intent,
      targetSnapshot: run.targetSnapshot,
      recordingSessionId: envelope.recordingSessionId,
      sequence: envelope.sequence,
      revision: envelope.revision,
      capabilities: envelope.capabilities,
      outcome: envelope.outcome ?? outcome,
      ...(liveState ? {
        liveDictation: {
          halted: liveState.halted,
          uncertain: liveState.uncertain,
          hasAcceptedEvents: liveState.hasAcceptedEvents,
          dispatchedProjectedLength: liveState.dispatchedProjectedLength,
          rawCommitted: liveState.rawCommitted,
        },
      } : {}),
    };
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

  private handleAudioStreamReady = (): void => {
    this.audioCapture.markReady?.();
  };

  private handleAudioFirstBuffer = (
    _event: unknown,
    generation: number,
    recordingSessionId: string,
    sequence: number,
  ): void => {
    if (!this.acceptsAudioMarker(generation, recordingSessionId, sequence)) return;
    if (this.activeRun) this.onFirstAudioBufferCallback?.(this.activeRun.transcriber);
  };

  private acceptsAudioMarker(generation: number, recordingSessionId: string, sequence: number): boolean {
    const run = this.activeRun;
    return Boolean(run && run.id === recordingSessionId && run.sequence === sequence && (
      this.runtimeShellBackend?.acceptsAudioEvent?.(generation, recordingSessionId, sequence) ?? true
    ));
  }

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
    this.teardownLiveDictation(run);
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


