import type { DictationTargetSnapshot, RecordingIntent } from '../types/ipc';
import { createAudioWindow, destroyAudioWindow, getAudioWindow } from './audio-window';
import type { AudioStreamAdapter } from './audio-stream';
import { AudioStream } from './audio-stream';
import { keyboardHook } from './native/keyboard';
import { captureForegroundTarget } from './native/target';
import { hideRecordingPill, showRecordingPill } from './recording-pill';
import { transcribe } from './whisper';

export interface RecordingResult {
  text: string;
  intent: RecordingIntent;
  targetSnapshot: DictationTargetSnapshot | null;
}

interface KeyboardHookAdapter {
  start: (
    onStart: (intent: RecordingIntent) => void,
    onStop: () => void,
    isAgentModeEnabled?: () => boolean
  ) => void;
  stop: () => void;
}

interface RecordingSessionDeps {
  audioStream: AudioStreamAdapter;
  showRecordingPill: (intent: RecordingIntent) => void;
  hideRecordingPill: () => void;
  transcribe: (audioData: Uint8Array) => Promise<string>;
  keyboardHook: KeyboardHookAdapter;
  captureTarget: () => DictationTargetSnapshot | null;
  isAgentModeEnabled: () => boolean;
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

  constructor(private readonly deps: RecordingSessionDeps) {}

  begin(intent: RecordingIntent = 'dictation'): void {
    if (this.activeIntent) return;
    this.activeIntent = intent;
    this.targetSnapshot = this.deps.captureTarget();

    this.deps.audioStream.prepare();
    this.deps.audioStream.beginCapture();
    this.deps.showRecordingPill(intent);
  }

  async end(): Promise<RecordingResult | null> {
    if (!this.activeIntent) return null;

    const intent = this.activeIntent;
    this.activeIntent = null;
    this.deps.hideRecordingPill();
    this.deps.audioStream.endCapture();

    return new Promise((resolve, reject) => {
      this.pendingEnd = { resolve, reject, intent };
    });
  }

  async cancel(): Promise<void> {
    this.activeIntent = null;
    this.targetSnapshot = null;
    this.deps.hideRecordingPill();
    this.deps.audioStream.cancelCapture();
    this.pendingEnd?.resolve(null);
    this.pendingEnd = null;
  }

  isActive(): boolean {
    return this.activeIntent !== null;
  }

  markAudioWindowReady(): void {
    this.deps.audioStream.markReady();
  }

  markAudioWindowCrashed(reason: string): void {
    this.deps.audioStream.markCrashed(reason);
  }

  async complete(audioData: Uint8Array): Promise<RecordingResult | null> {
    const pendingEnd = this.pendingEnd;
    this.pendingEnd = null;
    const intent = pendingEnd?.intent ?? this.activeIntent ?? 'dictation';
    this.activeIntent = null;

    if (audioData.byteLength <= 44) {
      console.warn(`Skipping empty WAV payload: ${audioData.byteLength} bytes`);
      this.targetSnapshot = null;
      pendingEnd?.resolve(null);
      return null;
    }

    try {
      const text = await this.deps.transcribe(audioData);
      const snapshot = this.targetSnapshot;
      this.targetSnapshot = null;
      const result = text ? { text, intent, targetSnapshot: snapshot } : null;
      pendingEnd?.resolve(result);
      return result;
    } catch (error) {
      pendingEnd?.reject(error);
      if (!pendingEnd) {
        throw error;
      }
      return null;
    }
  }

  startKeyboardHook(onResult: (result: RecordingResult | null) => void | Promise<void>): void {
    this.deps.keyboardHook.start(
      (intent) => this.begin(intent),
      () => {
        void this.end().then(onResult);
      },
      this.deps.isAgentModeEnabled
    );
  }

  stopKeyboardHook(): void {
    this.deps.keyboardHook.stop();
  }
}

export function createRecordingSession(
  isAgentModeEnabled: () => boolean,
  audioStream: AudioStream = new AudioStream({
    createAudioWindow,
    getAudioWindow,
    destroyAudioWindow,
  })
): RecordingSession {
  return new RecordingSession({
    audioStream,
    showRecordingPill,
    hideRecordingPill,
    transcribe,
    keyboardHook,
    captureTarget: captureForegroundTarget,
    isAgentModeEnabled,
  });
}
