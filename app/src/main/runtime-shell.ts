import { screen } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import type {
  DictationRecoveryAction,
  RecordingIntent,
  RecordingPresentationEnvelope,
  RuntimeAudioCommand,
  RuntimePresentationSnapshot,
  RuntimePresentationState,
} from '../types/ipc';
import { createSingletonWindow } from './window-factory';

const SHELL_WIDTH = 172;
const SHELL_HEIGHT = 52;
const PREVIEW_WIDTH = 520;
const PREVIEW_HEIGHT = 116;
const FAILURE_WIDTH = 520;
const FAILURE_HEIGHT = 220;
const BOTTOM_MARGIN = 48;

/** Startup-warmed renderer shared by Batch Dictation capture and presentation. */
export class RuntimeShell {
  private ready = false;
  private pendingBegin: RecordingPresentationEnvelope | null = null;
  private activeCommand: RuntimeAudioCommand | null = null;
  private generation = 1;
  private revision = 0;
  private pendingSnapshot: RuntimePresentationSnapshot | null = null;
  private activeRecording: Extract<RuntimePresentationState, { kind: 'recording' }> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly windows;

  constructor(
    private onCrash?: (reason: string) => void,
    private readonly timers: {
      setTimeoutFn: typeof setTimeout;
      clearTimeoutFn: typeof clearTimeout;
    } = { setTimeoutFn: setTimeout, clearTimeoutFn: clearTimeout },
  ) {
    this.windows = createSingletonWindow({
      route: 'runtime',
      options: {
        width: SHELL_WIDTH,
        height: SHELL_HEIGHT,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        focusable: false,
        hasShadow: false,
        webPreferences: { backgroundThrottling: false },
      },
      onCreated: (win) => {
        win.webContents.on('did-finish-load', () => {
          if (!this.pendingSnapshot || win.isDestroyed()) return;
          win.webContents.send('runtime:snapshot', this.pendingSnapshot);
          this.pendingSnapshot = null;
        });
        win.webContents.on('did-fail-load', (_event, code, description) => {
          console.error(`Runtime shell failed to load: ${code} ${description}`);
        });
        win.webContents.on('render-process-gone', (_event, details) => {
          this.handleCrash(details.reason);
        });
      },
    });
  }

  prepare(): void {
    this.position(this.windows.create());
  }

  setCrashHandler(handler: (reason: string) => void): void {
    this.onCrash = handler;
  }

  markReady(): void {
    this.ready = true;
    if (this.pendingBegin) {
      const envelope = this.pendingBegin;
      this.pendingBegin = null;
      this.startAudio(envelope);
    }
  }

  markCrashed(reason: string): void {
    this.handleCrash(reason);
  }

  beginCapture(envelope?: RecordingPresentationEnvelope): void {
    if (!envelope) return;
    if (!this.ready) {
      this.pendingBegin = envelope;
      return;
    }
    this.startAudio(envelope);
  }

  endCapture(): boolean {
    this.pendingBegin = null;
    if (!this.activeCommand) return false;
    this.send('runtime:audio-stop', this.activeCommand);
    return true;
  }

  cancelCapture(): void {
    this.endCapture();
  }

  setSelectedDevice(deviceId: string | null): void {
    this.ready = false;
    this.pendingBegin = null;
    this.send('audio:recreate-stream', deviceId);
  }

  show(
    intent: RecordingIntent,
    recordingSessionId?: string,
    envelope?: RecordingPresentationEnvelope,
  ): void {
    this.cancelPendingHide();
    const win = this.windows.create();
    this.position(win);
    this.resize(SHELL_WIDTH, SHELL_HEIGHT, false);
    if (recordingSessionId && envelope) {
      this.activeRecording = {
        kind: 'recording',
        recordingSessionId,
        intent,
        capabilities: envelope.capabilities,
        durationWarningSeconds: null,
      };
      this.publish(this.activeRecording);
    }
    const publish = () => {
      if (win.isDestroyed()) return;
      win.webContents.send('recording:pill-show', recordingSessionId, envelope);
      win.webContents.send('recording:mode-changed', intent);
      if (!win.isVisible()) win.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver');
    };
    if (win.webContents.isLoading()) win.once('ready-to-show', publish);
    else publish();
  }

  hide(): void {
    this.send('recording:pill-hide');
    const win = this.windows.get();
    if (!win || win.isDestroyed()) return;
    this.hideTimer = this.timers.setTimeoutFn(() => {
      if (!win.isDestroyed()) win.hide();
      this.hideTimer = null;
    }, 100);
  }

  showStreamingPreview(
    recordingSessionId: string,
    committed: string,
    tentative: string,
  ): void {
    if (this.activeRecording?.recordingSessionId !== recordingSessionId) return;
    if (
      this.activeRecording.committed === committed
      && this.activeRecording.tentative === tentative
    ) return;
    const previewWasVisible = this.activeRecording.committed !== undefined
      || this.activeRecording.tentative !== undefined;
    this.cancelPendingHide();
    if (!previewWasVisible) this.resize(PREVIEW_WIDTH, PREVIEW_HEIGHT, false);
    this.activeRecording = { ...this.activeRecording, committed, tentative };
    this.publish(this.activeRecording);
    if (!previewWasVisible) this.showPassive();
  }

  showProcessing(recordingSessionId: string): void {
    this.activeRecording = null;
    this.cancelPendingHide();
    this.send('recording:pill-hide');
    this.resize(SHELL_WIDTH, SHELL_HEIGHT, false);
    this.publish({ kind: 'processing', recordingSessionId });
    this.showPassive();
  }

  showFailure(
    recordingSessionId: string | null,
    message: string,
    recoveryActions: DictationRecoveryAction[] = [],
  ): void {
    this.activeRecording = null;
    this.cancelPendingHide();
    this.resize(FAILURE_WIDTH, FAILURE_HEIGHT, false, recoveryActions.length > 0);
    this.publish({ kind: 'failure', recordingSessionId, message, recoveryActions });
    this.showPassive();
  }

  finish(): void {
    this.activeCommand = null;
    this.activeRecording = null;
    this.resize(SHELL_WIDTH, SHELL_HEIGHT, false);
    this.publish({ kind: 'idle' });
    this.send('recording:pill-hide');
    this.cancelPendingHide();
    const win = this.windows.get();
    if (win && !win.isDestroyed()) win.hide();
  }

  updateDurationWarning(remainingSeconds: number | null): void {
    this.send('recording:duration-warning', remainingSeconds);
  }

  updateAudioLevel(level: number): void {
    this.send('audio:level-changed', level);
  }

  getWebContents(): WebContents | null {
    const win = this.windows.get();
    return win && !win.isDestroyed() ? win.webContents : null;
  }

  acceptsAudioEvent(generation: number, recordingSessionId: string, sequence: number): boolean {
    return this.activeCommand?.generation === generation
      && this.activeCommand.recordingSessionId === recordingSessionId
      && this.activeCommand.sequence === sequence;
  }

  consumeAudioEvent(generation: number, recordingSessionId: string, sequence: number): boolean {
    if (!this.acceptsAudioEvent(generation, recordingSessionId, sequence)) return false;
    this.activeCommand = null;
    return true;
  }

  destroy(): void {
    this.cancelPendingHide();
    this.ready = false;
    this.pendingBegin = null;
    this.activeCommand = null;
    this.activeRecording = null;
    this.windows.destroy();
  }

  private send(channel: string, ...args: unknown[]): void {
    const webContents = this.getWebContents();
    webContents?.send(channel, ...args);
  }

  private startAudio(envelope: RecordingPresentationEnvelope): void {
    this.activeCommand = {
      generation: this.generation,
      recordingSessionId: envelope.recordingSessionId,
      sequence: envelope.sequence,
      streaming: envelope.streamingActive === true,
    };
    this.send('runtime:audio-start', this.activeCommand);
  }

  private publish(state: RuntimePresentationState): void {
    this.revision += 1;
    const snapshot = {
      ...state,
      generation: this.generation,
      revision: this.revision,
    } as RuntimePresentationSnapshot;
    const win = this.windows.get();
    if (!win || win.isDestroyed() || win.webContents.isLoading()) {
      this.pendingSnapshot = snapshot;
      return;
    }
    win.webContents.send('runtime:snapshot', snapshot);
  }

  private showPassive(): void {
    const win = this.windows.get();
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
  }

  private resize(
    width: number,
    height: number,
    focusable: boolean,
    interactive = focusable,
  ): void {
    const win = this.windows.get();
    if (!win || win.isDestroyed()) return;
    const display = screen.getPrimaryDisplay();
    const x = display.workArea.x + Math.max(0, (display.workArea.width - width) / 2);
    const y = display.workArea.y + Math.max(0, display.workArea.height - height - BOTTOM_MARGIN);
    win.setFocusable(focusable);
    win.setIgnoreMouseEvents(!interactive, { forward: !interactive });
    win.setBounds({ x: Math.round(x), y: Math.round(y), width, height }, false);
  }

  private position(win: Pick<BrowserWindow, 'setPosition'>): void {
    const { workArea, workAreaSize } = screen.getPrimaryDisplay();
    const x = workArea.x + Math.max(0, (workAreaSize.width - SHELL_WIDTH) / 2);
    const y = workArea.y + Math.max(0, workAreaSize.height - SHELL_HEIGHT - BOTTOM_MARGIN);
    win.setPosition(Math.round(x), Math.round(y));
  }

  private cancelPendingHide(): void {
    if (!this.hideTimer) return;
    this.timers.clearTimeoutFn(this.hideTimer);
    this.hideTimer = null;
  }

  private handleCrash(reason: string): void {
    this.ready = false;
    this.pendingBegin = null;
    this.activeCommand = null;
    this.activeRecording = null;
    this.generation += 1;
    this.revision = 0;
    this.pendingSnapshot = null;
    this.windows.destroy();
    this.prepare();
    this.onCrash?.(reason);
  }
}
