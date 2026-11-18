import { randomUUID } from 'crypto';
import { ipcMain, type IpcMainEvent } from 'electron';
import {
  PRE_ROLL_MS,
  type DictationConfig,
  type DictationTargetSnapshot,
  type RecordingActivationMode,
  type RecordingIntent,
  type RecordingPresentationEnvelope,
  type ShortcutBinding,
} from '../types/ipc';
import {
  createRecordingPresentationEnvelope,
  getTranscriptionTransportCapabilities,
} from '../shared/dictation-runtime';
import {
  TranscriptionFailure,
  type RecognitionSettings,
  type StreamingTranscriptionSession,
  type Transcriber,
} from './transcription';
import { createStreamingTranscriptLedger, type StreamingTranscriptLedger } from './streaming-transcript';
import { RECOGNITION_TIMEOUT_MS } from './managed-local-runtime';
import { markTiming } from './eval-timing';
import { detachedPreRoll, isNearSilent, MIN_HOLD_MS } from './dictation-admission';

/** Longest Dictation release tail (Hex's cap); the capture renderer usually keeps ~200 ms. */
const MAX_RELEASE_TAIL_MS = 600;
// ponytail: wall-clock margin under a provider's duration cap for IPC and audio-thread lag.
const DURATION_CAP_MARGIN_MS = 100;
// The Start cue (250 ms, renderer/recording-cues.ts) plus IPC and output latency.
// The silence gate skips this much after a cued start so a cue heard through
// speakers is not mistaken for speech; recognition still gets every sample.
const START_CUE_HEAD_SAMPLES = 16_000 * 0.3;
const MAX_PRE_ROLL_SAMPLES = 16_000 * PRE_ROLL_MS / 1000;

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
  outcome: NonNullable<RecordingPresentationEnvelope['outcome']>;
  dictation: DictationDeliveryContext | null;
  signal: AbortSignal;
}

type RuntimeShellBackend = Pick<import('./runtime-shell').RuntimeShell,
  'prepare' | 'beginCapture' | 'endCapture' | 'cancelCapture' | 'setSelectedDevice' |
  'destroy' | 'markReady' | 'getWebContents' | 'show' | 'hide' | 'showProcessing' |
  'finish' | 'updateDurationWarning' | 'showStreamingPreview' |
  'markCaptureReady' | 'acceptsAudioEvent' | 'consumeAudioEvent' | 'setRecordingHandlers' | 'playCue'>;

type KeyboardHook = Pick<import('./native/keyboard').KeyboardHook, 'start' | 'stop' | 'recordingEndedExternally'>;

export interface RecordingSessionOptions {
  isAgentModeEnabled: () => boolean;
  getRecordingActivationMode: (intent: RecordingIntent) => RecordingActivationMode;
  getShortcutBinding: (intent: RecordingIntent) => ShortcutBinding | null;
  getSelectedDeviceId: () => string | null;
  getRecognitionSettings: (intent: RecordingIntent) => RecognitionSettings;
  getDictationContext: () => DictationDeliveryContext;
  getReadinessError: (intent: RecordingIntent) => Error | null;
  onResult: (result: RecordingResult | null) => void | Promise<void>;
  onError: (error: Error) => void;
  onBegin?: (intent: RecordingIntent) => void;

  runtimeShell: RuntimeShellBackend;
  keyboardHook: KeyboardHook;
  getTranscriber: () => Transcriber;
  captureTarget: () => DictationTargetSnapshot | null;
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
  state: 'starting' | 'recording' | 'stopping' | 'transcribing' | 'delivering';
  /** Date.now() at the capture's first sample, pre-roll included; bounds the release tail under a provider cap. */
  recordingSince: number | null;
  /** Warm pre-roll heading the spool, in 16 kHz samples. */
  preRollSamples: number;
  /** Head samples the silence gate skips: warm pre-roll, then the Start cue if it played at capture-ready. */
  gateSkipSamples: number;
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
  private keyboardHook: KeyboardHook;
  private getTranscriber: () => Transcriber;
  private getRecognitionSettings: (intent: RecordingIntent) => RecognitionSettings;
  private getDictationContext: () => DictationDeliveryContext;
  private getReadinessError: (intent: RecordingIntent) => Error | null;
  private captureTarget: () => DictationTargetSnapshot | null;
  private runtimeShell: RuntimeShellBackend;
  private setTimeoutFn: typeof setTimeout;
  private clearTimeoutFn: typeof clearTimeout;
  private durationTimers: Array<ReturnType<typeof setTimeout>> = [];
  private captureStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private onResultCallback: (result: RecordingResult | null) => void | Promise<void>;
  private onErrorCallback: (error: Error) => void;
  private onBeginCallback?: (intent: RecordingIntent) => void;
  private getSelectedDeviceId: () => string | null;

  constructor(options: RecordingSessionOptions) {
    this.isAgentModeEnabled = options.isAgentModeEnabled;
    this.getRecordingActivationMode = options.getRecordingActivationMode;
    this.getShortcutBinding = options.getShortcutBinding;
    this.runtimeShell = options.runtimeShell;
    this.keyboardHook = options.keyboardHook;
    this.getTranscriber = options.getTranscriber;
    this.getRecognitionSettings = options.getRecognitionSettings;
    this.getDictationContext = options.getDictationContext;
    this.getReadinessError = options.getReadinessError;
    this.captureTarget = options.captureTarget;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.onResultCallback = options.onResult;
    this.onErrorCallback = options.onError;
    this.onBeginCallback = options.onBegin;
    this.getSelectedDeviceId = options.getSelectedDeviceId;
    this.runtimeShell.setRecordingHandlers({
      onCrash: reason => this.handleAudioRendererCrash(reason),
      onAudioData: this.handleRuntimeAudioDataReady,
      onAudioFailed: this.handleRuntimeAudioFailed,
    });
  }

  begin(intent: RecordingIntent = 'dictation', recordingSessionId: string = randomUUID()): boolean {
    const pressedAt = Date.now();
    if (this.activeRun !== null) {
      return false;
    }
    const readinessError = this.getReadinessError(intent);
    if (readinessError) {
      this.onErrorCallback(readinessError);
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
      state: 'starting',
      recordingSince: null,
      preRollSamples: 0,
      gateSkipSamples: 0,
      abort: new AbortController(),
      dictation: intent === 'dictation' ? structuredClone(this.getDictationContext()) : null,
      pendingEnd: null,
      streaming: null,
    };
    this.activeRun = run;
    const streaming = this.startStreamingIfEligible(run);

    this.onBeginCallback?.(intent);

    const deviceId = this.getSelectedDeviceId();
    console.log(`Starting recording session. Device: ${deviceId ?? 'default'}`);

    const presentation = this.createPresentationEnvelope(run);
    this.runtimeShell.prepare();
    // Pre-roll waits for the silence gate, so only a Dictation recognized after it ends takes it:
    // live streaming would recognize, and preview, pre-press audio before the gate could refuse it.
    this.runtimeShell.beginCapture(presentation, intent === 'dictation' && !streaming ? pressedAt : null);
    this.runtimeShell.show(
      intent,
      run.id,
      presentation,
    );
    this.captureStartupTimer = this.setTimeoutFn(() => {
      if (this.activeRun !== run || run.state !== 'starting') return;
      this.runtimeShell.cancelCapture();
      this.failActiveCapture(new TranscriptionFailure('unknown', 'Microphone did not start in time. Check the input device and try again.'));
    }, 30_000);
    return true;
  }

  /**
   * Stops capture. `release` marks the user's own Stop, with how long a
   * push-to-talk chord was held (null for Toggle or unknown timing). A
   * Dictation hold shorter than MIN_HOLD_MS is an accidental tap: it is
   * discarded like a cancel, with no recognition and no toast. Otherwise
   * Dictation keeps a bounded release tail so a last word still sounding is
   * not cut. Agent Mode and the provider duration cap stop at once.
   */
  async end(release: { heldMs: number | null } | null = null): Promise<RecordingResult | null> {
    const run = this.activeRun;
    if (!run || (run.state !== 'starting' && run.state !== 'recording')) return null;

    if (run.intent === 'dictation' && release?.heldMs != null && release.heldMs < MIN_HOLD_MS) {
      console.info('Discarded an accidental Dictation hold', { heldMs: release.heldMs });
      await this.cancel();
      return null;
    }
    const tailMs = release && run.intent === 'dictation' ? this.releaseTailCap(run) : 0;
    this.clearDurationTimers();
    run.state = 'stopping';
    this.runtimeShell.showProcessing(run.id, run.intent);
    return new Promise((resolve, reject) => {
      run.pendingEnd = { resolve, reject };
      if (this.runtimeShell.endCapture(tailMs > 0 ? Date.now() + tailMs : 0) === false) {
        this.cancelStreaming(run);
        run.pendingEnd = null;
        this.runtimeShell.finish();
        if (this.activeRun === run) this.activeRun = null;
        resolve(null);
      }
    });
  }

  /** The longest tail that keeps the recording within the provider's duration cap. */
  private releaseTailCap(run: RecordingRunContext): number {
    if (run.recordingSince === null) return 0;
    const maxSeconds = run.transcriber.capabilities.maxDurationSeconds;
    if (!maxSeconds) return MAX_RELEASE_TAIL_MS;
    const remaining = maxSeconds * 1000 - (Date.now() - run.recordingSince) - DURATION_CAP_MARGIN_MS;
    return Math.max(0, Math.min(MAX_RELEASE_TAIL_MS, remaining));
  }

  async cancel(): Promise<void> {
    this.clearDurationTimers();
    const run = this.activeRun;
    this.runtimeShell.hide();
    this.runtimeShell.cancelCapture();
    this.runtimeShell.finish();
    if (run) {
      run.abort.abort();
      this.cancelStreaming(run);
      run.pendingEnd?.resolve(null);
      this.activeRun = null;
    }
  }

  isBusy(): boolean {
    return this.activeRun !== null;
  }

  handleAudioRendererCrash(reason: string): void {
    const error = new Error(`Audio window crashed: ${reason}`);
    this.clearDurationTimers();
    const run = this.activeRun;
    this.runtimeShell.hide();
    if (run) {
      run.abort.abort();
      this.cancelStreaming(run);
      run.pendingEnd?.reject(error);
      this.activeRun = null;
    }
    this.onErrorCallback(error);
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
    // Capture has ended, so the cue cannot be recorded; a warm mic keeps it out of the next pre-roll.
    if (run.recordingSince !== null) this.runtimeShell.playCue('stop');
    const pendingEnd = run.pendingEnd;

    const empty = audioData.byteLength <= 44;
    if (empty && run.intent !== 'dictation') {
      console.warn(`Skipping empty WAV payload: ${audioData.byteLength} bytes`);
      const error = new TranscriptionFailure(
        'unknown',
        'No microphone audio was captured. Check the selected input device and try again.',
      );
      this.cancelStreaming(run);
      run.streaming = null;
      audioData.fill(0);
      pendingEnd?.reject(error);
      this.onErrorCallback(error);
      this.activeRun = null;
      return null;
    }

    const spooled = empty ? new Int16Array(0) : new Int16Array(audioData.buffer, audioData.byteOffset + 44, (audioData.byteLength - 44) >> 1);
    // Pre-roll that a pause separates from the speech after it is not this utterance's start. A
    // stalled cap timer can let capture run long; the provider's limit holds on the samples themselves.
    const lead = detachedPreRoll(spooled, run.preRollSamples);
    const maxSamples = (run.transcriber.capabilities.maxDurationSeconds ?? 0) * 16_000;
    // The gate judges only what the provider will hear, but sees the whole pre-roll: a dropped
    // head that held sound still shows the device works, so a flat remainder is discarded.
    const judged = spooled.subarray(0, maxSamples ? lead + maxSamples : spooled.length);
    const pcm = judged.subarray(lead);
    // Pre-roll alone never admits a Dictation: media or room noise before the press is not speech.
    if (run.intent === 'dictation' && (judged.length <= run.gateSkipSamples || isNearSilent(judged, run.gateSkipSamples))) {
      // Models hallucinate on silence; an empty Dictation ends quietly, like a cancel.
      // Empty means stopped before the microphone delivered audio: a dead device still delivers zeros.
      console.info('Discarded near-silent Dictation without recognizing it', { samples: pcm.length });
      this.cancelStreaming(run);
      this.runtimeShell.finish();
      audioData.fill(0);
      pendingEnd?.resolve(null);
      this.activeRun = null;
      return null;
    }

    let wav = audioData;
    if (pcm.length !== spooled.length) {
      // The header moves to just before the first kept sample; `finally` zeroes the dropped head with the rest.
      audioData.copyWithin(lead * 2, 0, 44);
      wav = audioData.subarray(lead * 2, lead * 2 + 44 + pcm.byteLength);
      const header = new DataView(wav.buffer, wav.byteOffset);
      header.setUint32(4, 36 + pcm.byteLength, true);
      header.setUint32(40, pcm.byteLength, true);
    }
    const transcriber = run.transcriber;
    try {
      const recognized = await this.recognizeWithinDeadline(run, transcriber, wav);
      if (recognized === null || this.activeRun !== run) return null;
      const text = recognized;
      if (!text.trim()) {
        // Content-free level summary so a silent mic is distinguishable from a decoder miss.
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
      markTiming('transcript');
      const result = this.createRecordingResult(run, text, { kind: 'completed' });
      run.state = 'delivering';
      await this.onResultCallback(result);
      if (this.activeRun !== run) return null;
      pendingEnd?.resolve(result);
      return result;
    } catch (error) {
      if (this.activeRun !== run) return null;
      const err = error instanceof Error ? error : new Error(String(error));
      if (run.state === 'delivering') {
        pendingEnd?.reject(err);
        this.onErrorCallback(err);
        return null;
      }
      const recognizedSoFar = run.streaming?.ledger.current().committed;
      if (recognizedSoFar) {
        const result = this.createRecordingResult(
          run,
          recognizedSoFar,
          { kind: 'failed', message: err.message },
        );
        run.state = 'delivering';
        try {
          await this.onResultCallback(result);
        } catch (deliveryError) {
          if (this.activeRun !== run) return null;
          const failure = deliveryError instanceof Error ? deliveryError : new Error(String(deliveryError));
          pendingEnd?.reject(failure);
          this.onErrorCallback(failure);
          return null;
        }
        if (this.activeRun !== run) return null;
        pendingEnd?.resolve(result);
        return result;
      }
      pendingEnd?.reject(err);
      this.onErrorCallback(err);
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

  startKeyboardHook(): void {
    this.keyboardHook.start({
      onStart: (intent) => this.begin(intent),
      onStop: (heldMs) => { void this.end({ heldMs }).catch(() => undefined); },
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
    this.runtimeShell.prepare();

    ipcMain.on('audio-stream-ready', this.handleAudioStreamReady);
    ipcMain.on('runtime:audio-ready', this.handleRuntimeAudioReady);
    ipcMain.on('runtime:audio-failed', this.handleRendererAudioFailed);
    ipcMain.on('runtime:audio-chunk', this.handleRuntimeAudioChunk);
    ipcMain.on('runtime:audio-stream-disabled', this.handleRuntimeAudioStreamDisabled);

    this.startKeyboardHook();
  }

  stop(): void {
    this.clearDurationTimers();
    ipcMain.off('audio-stream-ready', this.handleAudioStreamReady);
    ipcMain.off('runtime:audio-ready', this.handleRuntimeAudioReady);
    ipcMain.off('runtime:audio-failed', this.handleRendererAudioFailed);
    ipcMain.off('runtime:audio-chunk', this.handleRuntimeAudioChunk);
    ipcMain.off('runtime:audio-stream-disabled', this.handleRuntimeAudioStreamDisabled);

    void this.cancel();
    this.stopKeyboardHook();
    this.runtimeShell.destroy();
  }

  /** Applies at once: the renderer finishes an in-flight capture on its mic and releases the old one. */
  updateDevice(deviceId: string | null): void {
    this.runtimeShell.setSelectedDevice(deviceId);
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
          this.runtimeShell.showStreamingPreview(
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
    text: string,
    outcome: RecordingResult['outcome'],
  ): RecordingResult {
    return {
      text,
      intent: run.intent,
      targetSnapshot: run.targetSnapshot,
      recordingSessionId: run.id,
      outcome,
      dictation: run.dictation,
      signal: run.abort.signal,
    };
  }

  private createPresentationEnvelope(
    run: RecordingRunContext,
  ): RecordingPresentationEnvelope {
    run.sequence += 1;
    run.revision += 1;
    return createRecordingPresentationEnvelope({
      recordingSessionId: run.id,
      sequence: run.sequence,
      revision: run.revision,
      capabilities: run.transcriber.transportCapabilities
        ?? getTranscriptionTransportCapabilities(run.transcriber.id),
      streamingActive: run.streaming !== null && !run.streaming.failed,
    });
  }

  /** `recordedMs` of audio (the pre-roll) already counts against the provider's cap. */
  private scheduleDurationLimit(maxDurationSeconds: number | null, recordedMs: number): void {
    this.clearDurationTimers();
    if (!maxDurationSeconds) return;
    const warningSeconds = Math.min(10, maxDurationSeconds);
    const warningStart = maxDurationSeconds - warningSeconds;
    for (let elapsed = warningStart; elapsed < maxDurationSeconds; elapsed++) {
      const remaining = maxDurationSeconds - elapsed;
      this.durationTimers.push(this.setTimeoutFn(() => {
        if (this.activeRun?.state === 'recording') this.runtimeShell.updateDurationWarning(remaining);
      }, Math.max(0, elapsed * 1000 - recordedMs)));
    }
    this.durationTimers.push(this.setTimeoutFn(() => {
      if (this.activeRun?.state !== 'recording') return;
      this.keyboardHook.recordingEndedExternally();
      void this.end().catch(() => undefined);
    }, Math.max(0, maxDurationSeconds * 1000 - recordedMs)));
  }

  private clearDurationTimers(): void {
    if (this.captureStartupTimer !== null) this.clearTimeoutFn(this.captureStartupTimer);
    this.captureStartupTimer = null;
    for (const timer of this.durationTimers) this.clearTimeoutFn(timer);
    this.durationTimers = [];
    this.runtimeShell.updateDurationWarning(null);
  }

  private handleAudioStreamReady = (): void => {
    this.runtimeShell.markReady();
  };

  private handleRuntimeAudioReady = (
    event: import('electron').IpcMainEvent,
    generation: number,
    recordingSessionId: string,
    sequence: number,
    preRollSamples: unknown,
  ): void => {
    const run = this.activeRun;
    if (!run || run.id !== recordingSessionId || run.sequence !== sequence) return;
    if (!event.sender || event.sender !== this.runtimeShell.getWebContents()) return;
    if (!this.runtimeShell.acceptsAudioEvent(generation, recordingSessionId, sequence)) return;
    const preRoll = Number.isSafeInteger(preRollSamples) && Number(preRollSamples) > 0
      ? Math.min(Number(preRollSamples), MAX_PRE_ROLL_SAMPLES)
      : 0;
    // A Stop that beat this ack still spools the pre-roll: the gate must skip it.
    if (run.state === 'stopping' && run.recordingSince === null) run.gateSkipSamples = run.preRollSamples = preRoll;
    if (run.state !== 'starting') return;
    run.state = 'recording';
    run.preRollSamples = preRoll;
    markTiming('capture-ready', { preRollSamples: preRoll });
    const preRollMs = preRoll * 1000 / 16_000;
    run.recordingSince = Date.now() - preRollMs;
    this.runtimeShell.markCaptureReady(run.id);
    run.gateSkipSamples = preRoll + (this.runtimeShell.playCue('start') ? START_CUE_HEAD_SAMPLES : 0);
    this.scheduleDurationLimit(run.transcriber.capabilities.maxDurationSeconds, preRollMs);
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
    const acceptedIdentity = this.runtimeShell.acceptsAudioEvent(generation, recordingSessionId, commandSequence);
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
          this.runtimeShell.getWebContents()?.send(
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
    const acceptedIdentity = this.runtimeShell.acceptsAudioEvent(generation, recordingSessionId, commandSequence);
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
    if (!this.runtimeShell.consumeAudioEvent(generation, recordingSessionId, sequence)) {
      data.fill(0);
      return;
    }
    try {
      await this.complete(data);
    } catch {
      // Defensively catch in async ipcMain.on listener
    }
  };

  private handleRendererAudioFailed = (
    event: IpcMainEvent,
    generation: number,
    recordingSessionId: string,
    sequence: number,
  ): void => {
    if (event.sender !== this.runtimeShell.getWebContents()) return;
    this.handleRuntimeAudioFailed(event, generation, recordingSessionId, sequence);
  };

  private handleRuntimeAudioFailed = (
    _event: unknown,
    generation: number,
    recordingSessionId: string,
    sequence: number,
  ): void => {
    if (!this.runtimeShell.consumeAudioEvent(generation, recordingSessionId, sequence)) return;
    this.failActiveCapture();
  };

  private failActiveCapture(error = new TranscriptionFailure(
    'unknown', 'Microphone capture failed. Check the selected input device and try again.',
  )): void {
    const run = this.activeRun;
    if (!run) return;
    this.cancelStreaming(run);
    this.clearDurationTimers();
    this.keyboardHook.recordingEndedExternally();
    run.pendingEnd?.reject(error);
    this.onErrorCallback(error);
    if (this.activeRun === run) this.activeRun = null;
  }

}

