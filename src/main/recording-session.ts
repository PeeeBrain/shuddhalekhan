import type { BrowserWindow } from 'electron';
import type { RecordingIntent } from '../types/ipc';
import { createAudioWindow, destroyAudioWindow, getAudioWindow } from './audio-window';
import { keyboardHook } from './native/keyboard';
import { hideRecordingPill, showRecordingPill } from './recording-pill';
import { transcribe } from './whisper';

export interface RecordingResult {
  text: string;
  intent: RecordingIntent;
}

type AudioWindow = Pick<BrowserWindow, 'isDestroyed' | 'webContents'>;

interface KeyboardHookAdapter {
  start: (
    onStart: (intent: RecordingIntent) => void,
    onStop: () => void,
    isAgentModeEnabled?: () => boolean
  ) => void;
  stop: () => void;
}

interface RecordingSessionDeps {
  createAudioWindow: () => AudioWindow;
  getAudioWindow: () => AudioWindow | null;
  destroyAudioWindow: () => void;
  showRecordingPill: (intent: RecordingIntent) => void;
  hideRecordingPill: () => void;
  transcribe: (audioData: Uint8Array) => Promise<string>;
  keyboardHook: KeyboardHookAdapter;
  isAgentModeEnabled: () => boolean;
}

export class RecordingSession {
  private activeIntent: RecordingIntent | null = null;
  private isAudioWindowReady = false;
  private pendingStartRecording = false;
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

    const audioWin = this.deps.createAudioWindow();
    if (this.isAudioWindowReady && !audioWin.webContents.isLoading()) {
      audioWin.webContents.send('audio:start-recording');
    } else {
      this.pendingStartRecording = true;
      console.log('Queued recording start until audio window is ready');
    }

    this.deps.showRecordingPill(intent);
  }

  async end(): Promise<RecordingResult | null> {
    if (!this.activeIntent) return null;

    const intent = this.activeIntent;
    this.activeIntent = null;
    this.pendingStartRecording = false;
    this.deps.hideRecordingPill();
    this.stopAudioCapture();

    return new Promise((resolve, reject) => {
      this.pendingEnd = { resolve, reject, intent };
    });
  }

  async cancel(): Promise<void> {
    this.activeIntent = null;
    this.pendingStartRecording = false;
    this.deps.hideRecordingPill();
    this.stopAudioCapture();
    this.pendingEnd?.resolve(null);
    this.pendingEnd = null;
  }

  isActive(): boolean {
    return this.activeIntent !== null;
  }

  markAudioWindowReady(): void {
    this.isAudioWindowReady = true;
    console.log('Audio window ready');

    if (this.pendingStartRecording && this.activeIntent) {
      this.pendingStartRecording = false;
      const audioWin = this.deps.getAudioWindow();
      if (audioWin && !audioWin.isDestroyed()) {
        audioWin.webContents.send('audio:start-recording');
      }
    }
  }

  markAudioWindowCrashed(reason: string): void {
    this.isAudioWindowReady = false;
    console.error('Audio window renderer exited:', reason);
  }

  async complete(audioData: Uint8Array): Promise<RecordingResult | null> {
    const pendingEnd = this.pendingEnd;
    this.pendingEnd = null;
    const intent = pendingEnd?.intent ?? this.activeIntent ?? 'dictation';
    this.activeIntent = null;
    this.pendingStartRecording = false;

    if (audioData.byteLength <= 44) {
      console.warn(`Skipping empty WAV payload: ${audioData.byteLength} bytes`);
      pendingEnd?.resolve(null);
      return null;
    }

    try {
      const text = await this.deps.transcribe(audioData);
      const result = text ? { text, intent } : null;
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

  destroyAudioWindow(): void {
    this.deps.destroyAudioWindow();
  }

  private stopAudioCapture(): void {
    const audioWin = this.deps.getAudioWindow();
    if (audioWin && !audioWin.isDestroyed()) {
      audioWin.webContents.send('audio:stop-recording');
    }
  }
}

export function createRecordingSession(isAgentModeEnabled: () => boolean): RecordingSession {
  return new RecordingSession({
    createAudioWindow,
    getAudioWindow,
    destroyAudioWindow,
    showRecordingPill,
    hideRecordingPill,
    transcribe,
    keyboardHook,
    isAgentModeEnabled,
  });
}
