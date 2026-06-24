import type { BrowserWindow } from 'electron';

type AudioWindow = Pick<BrowserWindow, 'isDestroyed' | 'webContents'>;

export interface AudioStreamAdapter {
  prepare(): void;
  beginCapture(): void;
  endCapture(): void;
  cancelCapture(): void;
  markReady(): void;
  markCrashed(reason: string): void;
  isStreamReady(): boolean;
  setSelectedDevice(deviceId: string | null): void;
  destroy(): void;
}

export interface AudioStreamDeps {
  createAudioWindow: () => AudioWindow;
  getAudioWindow: () => AudioWindow | null;
  destroyAudioWindow: () => void;
}

export class AudioStream {
  private isReady = false;
  private prepared = false;
  private pendingBegin = false;

  constructor(private readonly deps: AudioStreamDeps) {}

  prepare(): void {
    if (this.prepared) return;
    this.deps.createAudioWindow();
    this.prepared = true;
  }

  markReady(): void {
    this.isReady = true;
    if (this.pendingBegin) {
      this.pendingBegin = false;
      this.sendStart();
    }
  }

  markCrashed(_reason: string): void {
    this.isReady = false;
    this.prepared = false;
    this.pendingBegin = false;
  }

  isStreamReady(): boolean {
    return this.isReady;
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
    const audioWin = this.deps.getAudioWindow();
    if (audioWin && !audioWin.isDestroyed()) {
      audioWin.webContents.send('audio:stop-recording');
    }
  }

  cancelCapture(): void {
    this.pendingBegin = false;
    const audioWin = this.deps.getAudioWindow();
    if (audioWin && !audioWin.isDestroyed()) {
      audioWin.webContents.send('audio:stop-recording');
    }
  }

  setSelectedDevice(deviceId: string | null): void {
    this.isReady = false;
    this.pendingBegin = false;
    const audioWin = this.deps.getAudioWindow();
    if (audioWin && !audioWin.isDestroyed()) {
      audioWin.webContents.send('audio:recreate-stream', deviceId);
    }
  }

  destroy(): void {
    this.deps.destroyAudioWindow();
  }

  private sendStart(): void {
    const audioWin = this.deps.getAudioWindow();
    if (audioWin && !audioWin.isDestroyed()) {
      audioWin.webContents.send('audio:start-recording');
    }
  }
}
