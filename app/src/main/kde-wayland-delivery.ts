import type { DictationTargetSnapshot, InjectResult, PasteStrategy } from '../types/ipc';
import type { WaylandInsertionStatus } from '../shared/desktop-status';

// Structural seams for desktop/kde-focus.ts and desktop/remote-desktop-keyboard.ts.
interface FocusSnapshot { windowId: string; epoch: number; appId: string }
interface FocusTracker {
  capture(): FocusSnapshot | null;
  validate(snapshot: FocusSnapshot): boolean;
  isAlive(): boolean;
  close(): Promise<void>;
}
interface PortalKeyboard {
  setup(): Promise<void>;
  isReady(): boolean;
  paste(strategy: PasteStrategy, signal: AbortSignal, validateTarget: () => boolean): Promise<{ acceptedEvents: number; error?: string }>;
  close(): Promise<void>;
}

export interface KdeWaylandDeliveryOptions {
  createTracker: () => Promise<FocusTracker>;
  createKeyboard: () => PortalKeyboard;
  /** Portal chord deactivation plus a fixed settle; see KeyboardHook.waitForShortcutDeactivation. */
  waitForShortcutRelease: (signal: AbortSignal) => Promise<boolean>;
  /** Writes the transcript to the clipboard and leaves it there; nothing is restored. */
  stageClipboard: (text: string) => Promise<void>;
  getPasteStrategy: (appId: string) => PasteStrategy;
  onChange: () => void;
}

export const BEST_EFFORT_DISCLOSURE = 'Best-effort test mode: final text is pasted only into the window that was active when recording began. Switching windows cancels the paste, but a change to another field inside that same window is not detected, and a focus change in the last moment before the paste can still be missed. The transcript is placed on the clipboard and left there.';

type KdeTarget = Extract<DictationTargetSnapshot, { kind: 'kde-wayland' }>;

const blocked = (reason: string): InjectResult => ({ kind: 'input-blocked', acceptedEvents: 0, reason });

/**
 * KDE Wayland best-effort insertion: KWin focus tracking pins the window active at
 * record start, and a RemoteDesktop portal session types the paste chord. Setup
 * (with its consent prompt) runs only from enable(), never during delivery. Each
 * delivery is attempted once; partial or uncertain dispatch is never retried.
 */
export class KdeWaylandDelivery {
  private tracker: FocusTracker | null = null;
  private keyboard: PortalKeyboard | null = null;
  private phase: 'off' | 'setting-up' | 'ready' | 'failed' = 'off';
  private failure = '';
  private generation = 0;

  constructor(private readonly options: KdeWaylandDeliveryOptions) {}

  /**
   * Runs focus tracking and the keyboard-control consent prompt. 'superseded'
   * means a later enable()/disable() owns the state now.
   */
  async enable(): Promise<'ready' | 'failed' | 'superseded'> {
    await this.disable();
    const generation = this.generation;
    this.phase = 'setting-up';
    this.options.onChange();
    let step = 'Window tracking could not start';
    try {
      const tracker = await this.options.createTracker();
      if (generation !== this.generation) {
        await tracker.close();
        return 'superseded';
      }
      // Held while pending so disable() (or quit) also closes a session still awaiting consent.
      this.tracker = tracker;
      step = 'Keyboard control was not granted';
      this.keyboard = this.options.createKeyboard();
      await this.keyboard.setup();
      if (generation !== this.generation) return 'superseded';
      this.phase = 'ready';
      this.options.onChange();
      return 'ready';
    } catch (error) {
      if (generation !== this.generation) return 'superseded';
      const { tracker, keyboard } = this;
      this.tracker = null;
      this.keyboard = null;
      this.phase = 'failed';
      this.failure = `${step}: ${error instanceof Error ? error.message : String(error)}`;
      await Promise.allSettled([tracker?.close(), keyboard?.close()]);
      this.options.onChange();
      return 'failed';
    }
  }

  async disable(): Promise<void> {
    this.generation += 1;
    const { tracker, keyboard } = this;
    const changed = this.phase !== 'off';
    this.tracker = null;
    this.keyboard = null;
    this.phase = 'off';
    await Promise.allSettled([tracker?.close(), keyboard?.close()]);
    if (changed) this.options.onChange();
  }

  isReady(): boolean {
    return this.phase === 'ready' && this.keyboard?.isReady() === true && this.tracker?.isAlive() === true;
  }

  status(): WaylandInsertionStatus {
    if (this.phase === 'setting-up') {
      return { state: 'setting-up', message: 'Waiting for KDE to allow keyboard control. Shortcut permission is separate and unaffected.' };
    }
    if (this.phase === 'failed') {
      return { state: 'unavailable', message: `${this.failure.replace(/\.+$/, '')}. Automatic insertion stays off; Last Transcript still works.` };
    }
    if (this.phase === 'ready') {
      if (this.isReady()) return { state: 'ready', message: BEST_EFFORT_DISCLOSURE };
      const lost = this.tracker?.isAlive() === true ? 'The keyboard-control session ended' : 'KWin window tracking stopped';
      return { state: 'unavailable', message: `${lost}. Set up best-effort insertion again.` };
    }
    return { state: 'off', message: 'Off. Finished transcripts stay in Last Transcript for you to copy.' };
  }

  /** Pinned once at record start; null leaves Dictation copy-only. */
  capture(): DictationTargetSnapshot | null {
    if (!this.isReady()) return null;
    const focus = this.tracker?.capture();
    return focus ? { kind: 'kde-wayland', ...focus, capturedAt: new Date().toISOString() } : null;
  }

  async deliver(text: string, target: KdeTarget, signal: AbortSignal): Promise<InjectResult> {
    const { tracker, keyboard } = this;
    if (!this.isReady() || !tracker || !keyboard) {
      return blocked('Best-effort insertion is no longer set up. Nothing was pasted.');
    }
    if (!await this.options.waitForShortcutRelease(signal)) {
      return blocked(signal.aborted ? 'Dictation was cancelled.' : 'Release the recording shortcut before pasting the transcript. Nothing was pasted.');
    }
    const original = { windowId: target.windowId, epoch: target.epoch, appId: target.appId };
    const stillOriginal = () => !signal.aborted && this.keyboard === keyboard && tracker.validate(original);
    if (!stillOriginal()) {
      return signal.aborted ? blocked('Dictation was cancelled.')
        : { kind: 'target-changed', reason: 'The window that was active when recording began is no longer active. Nothing was pasted.' };
    }
    await this.options.stageClipboard(text);
    if (!stillOriginal()) {
      return signal.aborted ? blocked('Dictation was cancelled.')
        : { kind: 'target-changed', reason: 'The original window lost focus before pasting. Nothing was pasted; the transcript is on the clipboard.' };
    }
    const result = await keyboard.paste(this.options.getPasteStrategy(target.appId), signal, stillOriginal);
    if (!result.error) return { kind: 'input-dispatched', acceptedEvents: result.acceptedEvents };
    if (result.acceptedEvents === 0) return blocked(`${result.error} Nothing was pasted; the transcript is on the clipboard.`);
    return { kind: 'error', message: `Paste was interrupted after some keys were sent (${result.error}). Check the destination; the transcript is on the clipboard.` };
  }
}
