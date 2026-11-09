import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type {
  DictationConfig,
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
import { keyboardHook, type KeyboardHookStartOptions } from './native/keyboard';
import { DEFAULT_SHORTCUTS } from '../shared/shortcut-bindings';
import { captureForegroundTarget } from './native/target';
import { localWhisperCppTranscriber } from './whisper';
import {
  TranscriptionFailure,
  cleanFillerWords,
  type RecognitionSettings,
  type StreamingTranscriptionSession,
  type Transcriber,
} from './transcription';
import { createStreamingTranscriptLedger, type StreamingTranscriptLedger } from './streaming-transcript';
import { RuntimeShell } from './runtime-shell';

/** Matches Managed Local's per-request bound; recording length itself is not capped here. */
const RECOGNITION_TIMEOUT_MS = 120_000;

/** Main-process-only settings and resolved formatter credential, pinned at Begin. */
export interface DictationDeliveryContext {
  config: DictationConfig;
  language: string;
  protectedTerms: string[];
  formatterApiKey: string | null;
}

export interface RecordingResult {
  text: string;
  intent: RecordingIntent;
  targetSnapshot: DictationTargetSnapshot | null;
  recordingSessionId: string;
  sequence: number;
  revision: number;
  capabilities: RecordingPresentationEnvelope['capabilities'];
  outcome: NonNullable<RecordingPresentationEnvelope['outcome']>;
  dictation: DictationDeliveryContext | null;
  signal: AbortSignal;
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
  markCaptureReady?(recordingSessionId: string): void;
  acceptsAudioEvent?(generation: number, recordingSessionId: string, sequence: number): boolean;
  consumeAudioEvent(generation: number, recordingSessionId: string, sequence: number): boolean;
}

export interface KeyboardHook {
  start(options: KeyboardHookStartOptions): void;
  stop(): void;
  recordingEndedExternally?(): void;
}

export interface RecordingSessionOptions {
  isAgentModeEnabled: () => boolean;
  getRecordingActivationMode?: (intent: RecordingIntent) => RecordingActivationMode;
  getShortcutBinding?: (intent: RecordingIntent) => ShortcutBinding | null;
  getSelectedDeviceId?: () => string | null;
  getRecognitionSettings?: (intent: RecordingIntent) => RecognitionSettings;
  getDictationContext?: () => DictationDeliveryContext;
  getReadinessError?: (intent: RecordingIntent) => Error | null;
  onResult?: (result: RecordingResult | null) => void | Promise<void>;
  onError?: (error: Error) => void;
  onBegin?: (intent: RecordingIntent) => void;

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
  recognition: RecognitionSettings;
  targetSnapshot: DictationTargetSnapshot | null;
  sequence: number;
  revision: number;
  state: 'recording' | 'stopping' | 'transcribing' | 'delivering';
  captureReady: boolean;
  abort: AbortController;
  dictation: DictationDeliveryContext | null;
  pendingEnd: {
    resolve: (result: RecordingResult | null) => void;
    reject: (error: unknown) => void;
  } | null;
  streaming: {
    session: StreamingTranscriptionSession;
    /** Latest preview, kept as Recognized So Far if finalization and fallback fail. */
    ledger: StreamingTranscriptLedger;
    queue: Promise<void>;
    expectedChunkSequence: number;
    failed: boolean;
    cancelled: boolean;
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
  private getRecognitionSettings: (intent: RecordingIntent) => RecognitionSettings;
  private getDictationContext: () => DictationDeliveryContext;
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
  private captureStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private onResultCallback?: (result: RecordingResult | null) => void | Promise<void>;
  private onErrorCallback?: (error: Error) => void;
  private onBeginCallback?: (intent: RecordingIntent) => void;
  private getSelectedDeviceId?: () => string | null;
  private pendingDeviceUpdate: { deviceId: string | null } | null = null;

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
    this.getDictationContext = options.getDictationContext ?? (() => ({
      config: { mode: 'batch', formatter: null }, language: 'auto', protectedTerms: [], formatterApiKey: null,
    }));
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
    const targetSnapshot = intent === 'dictation' ? this.captureTarget() : null;
    const transcriber = this.getTranscriber();
    const run: RecordingRunContext = {
      id: recordingSessionId,
      intent,
      transcriber,
      recognition: structuredClone(this.getRecognitionSettings(intent)),
      targetSnapshot,
      sequence: 0,
      revision: 0,
      state: 'recording',
      captureReady: false,
      abort: new AbortController(),
      dictation: intent === 'dictation' ? structuredClone(this.getDictationContext()) : null,
      pendingEnd: null,
      streaming: null,
    };
    this.activeRun = run;
    this.startStreamingIfEligible(run);

    this.onBeginCallback?.(intent);

    const deviceId = this.getSelectedDeviceId?.();
    console.log(`Starting recording session. Device: ${deviceId ?? 'default'}`);

    const presentation = this.createPresentationEnvelope(run);
    this.audioCapture.prepare();
    if (this.pendingDeviceUpdate) {
      this.audioCapture.setSelectedDevice(this.pendingDeviceUpdate.deviceId);
      this.pendingDeviceUpdate = null;
    }
    this.audioCapture.beginCapture(presentation);
    this.showRecordingPillFn(
      intent,
      run.id,
      presentation,
    );
    this.captureStartupTimer = this.setTimeoutFn(() => {
      if (this.activeRun !== run || run.state !== 'recording' || run.captureReady) return;
      this.audioCapture.cancelCapture();
      this.failActiveCapture(new TranscriptionFailure('unknown', 'Microphone did not start in time. Check the input device and try again.'));
    }, 30_000);
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
        this.cancelStreaming(run);
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
      run.abort.abort();
      this.cancelStreaming(run);
      run.pendingEnd?.resolve(null);
      this.activeRun = null;
    }
  }

  isActive(): boolean {
    return this.activeRun !== null && this.activeRun.state === 'recording';
  }

  isBusy(): boolean {
    return this.activeRun !== null;
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
      run.abort.abort();
      this.cancelStreaming(run);
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
    if (run.state === 'transcribing' || run.state === 'delivering') {
      audioData.fill(0);
      return null;
    }
    run.state = 'transcribing';
    this.clearDurationTimers();
    const pendingEnd = run.pendingEnd;

    if (audioData.byteLength <= 44) {
      console.warn(`Skipping empty WAV payload: ${audioData.byteLength} bytes`);
      const error = new TranscriptionFailure(
        'unknown',
        'No microphone audio was captured. Check the selected input device and try again.',
      );
      this.cancelStreaming(run);
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
      const recognized = await this.recognizeWithinDeadline(run, transcriber, audioData);
      if (recognized === null || this.activeRun !== run) return null;
      const text = run.recognition.removeFillerWords ? cleanFillerWords(recognized) : recognized;
      if (!text.trim()) {
        // Content-free level summary so a silent mic is distinguishable from a decoder miss.
        const pcm = new Int16Array(audioData.buffer, 44, (audioData.byteLength - 44) >> 1);
        let peak = 0;
        let energy = 0;
        for (const sample of pcm) {
          peak = Math.max(peak, Math.abs(sample));
          energy += sample * sample;
        }
        const level = { peak: peak / 32_768, rms: Math.sqrt(energy / pcm.length) / 32_768 };
        console.warn('No speech recognized', {
          samples: pcm.length, peak: +level.peak.toFixed(5), rms: +level.rms.toFixed(6),
        });
        // ponytail: fixed thresholds; speech peaks well above 0.01 and stays far below 0.3 RMS at sane gain.
        const hint = level.peak < 0.01 ? 'The microphone input was nearly silent; raise its input level or check the selected device.'
          : level.rms > 0.3 ? 'The microphone input was clipping; lower its input level in your system sound settings.'
            : 'Check the microphone input level and selected device.';
        throw new TranscriptionFailure('unknown', `No speech was recognized. ${hint} Then try again.`);
      }
      const result = this.createRecordingResult(run, transcriber, text, { kind: 'completed' });
      run.state = 'delivering';
      await this.onResultCallback?.(result);
      if (this.activeRun !== run) return null;
      if (!this.onResultCallback) this.finishPresentationFn?.();
      pendingEnd?.resolve(result);
      return result;
    } catch (error) {
      if (this.activeRun !== run) return null;
      const err = error instanceof Error ? error : new Error(String(error));
      if (run.state === 'delivering') {
        pendingEnd?.reject(err);
        this.onErrorCallback?.(err);
        return null;
      }
      const recognizedSoFar = run.streaming?.ledger.current().committed;
      if (recognizedSoFar) {
        const result = this.createRecordingResult(
          run,
          transcriber,
          recognizedSoFar,
          { kind: 'failed', message: err.message },
        );
        run.state = 'delivering';
        try {
          await this.onResultCallback?.(result);
        } catch (deliveryError) {
          if (this.activeRun !== run) return null;
          const failure = deliveryError instanceof Error ? deliveryError : new Error(String(deliveryError));
          pendingEnd?.reject(failure);
          this.onErrorCallback?.(failure);
          return null;
        }
        if (this.activeRun !== run) return null;
        if (!this.onResultCallback) this.finishPresentationFn?.();
        pendingEnd?.resolve(result);
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
      this.cancelStreaming(run);
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
    ipcMain.on('runtime:audio-ready', this.handleRuntimeAudioReady);
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
    ipcMain.off('runtime:audio-ready', this.handleRuntimeAudioReady);
    ipcMain.off('runtime:audio-chunk', this.handleRuntimeAudioChunk);
    ipcMain.off('runtime:audio-stream-disabled', this.handleRuntimeAudioStreamDisabled);
    ipcMain.off('runtime:audio-data-ready', this.handleRuntimeAudioDataReady);
    ipcMain.off('runtime:audio-failed', this.handleRuntimeAudioFailed);
    ipcMain.off('audio-level-changed', this.handleAudioLevelChanged);

    void this.cancel();
    this.stopKeyboardHook();
    this.audioCapture.destroy?.();
  }

  updateDevice(deviceId: string | null): void {
    // A device edit applies to the next recording, never its in-flight capture.
    if (this.activeRun) this.pendingDeviceUpdate = { deviceId };
    else this.audioCapture.setSelectedDevice(deviceId);
  }

  getAudioWebContents(): import('electron').WebContents | null {
    return this.audioCapture.getWebContents?.() ?? null;
  }

  private canStartLiveStreaming(transcriber: Transcriber): boolean {
    return typeof transcriber.startStreaming === 'function';
  }

  private startStreamingIfEligible(run: RecordingRunContext): boolean {
    if (!this.canStartLiveStreaming(run.transcriber)) return false;
    const startStreaming = run.transcriber.startStreaming;
    if (!startStreaming) return false;
    const ledger = createStreamingTranscriptLedger();
    try {
      const session = startStreaming({
        recognition: run.recognition,
        onSnapshot: (snapshot) => {
          if (this.activeRun !== run || run.streaming?.failed) return;
          const update = ledger.apply(snapshot);
          if (update.kind === 'protocol-failure') {
            this.disableStreaming(run);
            return;
          }
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
        cancelled: false,
      };
      return true;
    } catch {
      try {
        this.cancelStreaming(run);
      } catch {
        // Capture can still complete through the provider's batch path.
      }
      run.streaming = null;
      return false;
    }
  }

  private cancelStreaming(run: RecordingRunContext): void {
    if (!run.streaming || run.streaming.cancelled) return;
    run.streaming.cancelled = true;
    try {
      run.streaming.session.cancel();
    } catch {
      console.warn('Could not close the transcription stream.');
    }
  }

  private disableStreaming(run: RecordingRunContext): void {
    if (!run.streaming || run.streaming.failed) return;
    run.streaming.failed = true;
    this.cancelStreaming(run);
  }

  /**
   * Bounds recognition after stop. The deadline aborts the provider request and
   * stream, then fails without a fallback retry; run.abort stays untouched so
   * Recognized So Far can still be delivered. Cancellation resolves null at
   * once even when the provider ignores its signal.
   */
  private async recognizeWithinDeadline(
    run: RecordingRunContext,
    transcriber: Transcriber,
    audioData: Uint8Array<ArrayBuffer>,
  ): Promise<string | null> {
    const recognition = new AbortController();
    const cancelled = new Promise<null>((resolve) => {
      const onCancel = () => { recognition.abort(); resolve(null); };
      if (run.abort.signal.aborted) onCancel();
      else run.abort.signal.addEventListener('abort', onCancel, { once: true });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = this.setTimeoutFn(() => {
        reject(new TranscriptionFailure('network', 'Transcription did not finish in time.'));
        recognition.abort();
        this.cancelStreaming(run);
      }, RECOGNITION_TIMEOUT_MS);
    });
    const work = this.transcribeCompletedAudio(run, transcriber, audioData, recognition.signal);
    work.catch(() => undefined);
    try {
      return await Promise.race([work, deadline, cancelled]);
    } finally {
      this.clearTimeoutFn(timer);
    }
  }

  private async transcribeCompletedAudio(
    run: RecordingRunContext,
    transcriber: Transcriber,
    audioData: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<string | null> {
    const stale = () => signal.aborted || this.activeRun !== run;
    const streaming = run.streaming;
    if (streaming) {
      await streaming.queue;
      if (stale()) return null;
      if (!streaming.failed) {
        try {
          // The provider's final is authoritative, even where it revises the last preview.
          const providerFinal = await streaming.session.finish();
          if (stale()) return null;
          return providerFinal;
        } catch {
          if (stale()) return null;
          this.disableStreaming(run);
        }
      }
    }

    if (stale()) return null;
    const text = await transcriber.transcribe({ audio: audioData, recognition: run.recognition, signal });
    if (stale()) return null;
    return text;
  }

  private createRecordingResult(
    run: RecordingRunContext,
    transcriber: Transcriber,
    text: string,
    outcome: RecordingResult['outcome'],
  ): RecordingResult {
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
      dictation: run.dictation,
      signal: run.abort.signal,
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
    if (this.captureStartupTimer !== null) this.clearTimeoutFn(this.captureStartupTimer);
    this.captureStartupTimer = null;
    for (const timer of this.durationTimers) this.clearTimeoutFn(timer);
    this.durationTimers = [];
    this.updateDurationWarningFn(null);
  }

  private handleAudioStreamReady = (): void => {
    this.audioCapture.markReady?.();
  };

  private handleRuntimeAudioReady = (
    event: import('electron').IpcMainEvent,
    generation: number,
    recordingSessionId: string,
    sequence: number,
  ): void => {
    const run = this.activeRun;
    if (!run || run.id !== recordingSessionId || run.sequence !== sequence
      || run.state !== 'recording' || run.captureReady) return;
    if (!event.sender || event.sender !== this.audioCapture.getWebContents?.()) return;
    if (!this.runtimeShellBackend?.acceptsAudioEvent?.(generation, recordingSessionId, sequence)) return;
    run.captureReady = true;
    this.runtimeShellBackend.markCaptureReady?.(run.id);
    this.scheduleDurationLimit(run.transcriber.capabilities.maxDurationSeconds);
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
      if (streaming.failed || this.activeRun !== run) { pcm.fill(0); return; }
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

  private failActiveCapture(error = new TranscriptionFailure(
    'unknown', 'Microphone capture failed. Check the selected input device and try again.',
  )): void {
    const run = this.activeRun;
    if (!run) return;
    this.cancelStreaming(run);
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


