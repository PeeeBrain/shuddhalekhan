import type { DictationTargetSnapshot, PasteStrategy, InjectResult } from '../types/ipc';
import { buildPasteStrategyEvents, type PasteDispatchResult } from './paste-strategy';
import { markTiming } from './eval-timing';

export interface ClipboardSnapshot {
  wasEmpty: boolean;
  text?: string;
  html?: string;
  rtf?: string;
  imagePng?: Buffer;
  bookmark?: {
    title: string;
    url: string;
  };
  skippedFormats?: string[];
}

export interface ClipboardIO {
  captureSnapshot(): ClipboardSnapshot;
  restoreSnapshot(snapshot: ClipboardSnapshot): void;
  /** A deliberate copy: an ordinary clipboard entry the user keeps. */
  writeText(text: string): void;
  /**
   * Paste staging that is restored after the paste; kept out of clipboard history where the OS allows.
   * Where the OS allows, it writes only while the clipboard still has `expectedSequence`.
   * 'changed' means nothing was written; 'cleared' means the write failed after emptying the clipboard.
   * Throws only when the clipboard was left untouched.
   */
  writeTransientText(text: string, expectedSequence: number): TransientWrite;
}

export type TransientWrite = 'staged' | 'changed' | 'cleared';

export type ForegroundInspector = () => DictationTargetSnapshot | null;
export type InputSimulator = (strategy: PasteStrategy) => PasteDispatchResult;
export type ClipboardMonitor = () => number;
export type PasteStrategyResolver = (executablePath: string | null) => PasteStrategy;

export interface ClipboardTransactionManagerOptions {
  delayFn?: (ms: number) => Promise<void>;
  /** A restore after the paste went out failed; delivery has already been reported. */
  onRestoreFailed?: () => void;
}

const REMOTE_DESKTOP_CLIENTS = new Set(['mstsc.exe', 'msrdc.exe']);
const RESTORE_RETRY_MS = 100;

/**
 * How long staging settles before the paste chord, and how long the transcript stays on the clipboard after it.
 * Windows targets can read the clipboard well after SendInput returns; Remote Desktop forwards the clipboard to
 * the remote session asynchronously and fetches it only when the remote pastes.
 * X11 keeps its earlier timing until Linux consumers are measured.
 */
function pasteTimings(target: DictationTargetSnapshot | null): { settleMs: number; restoreMs: number } {
  if (target?.kind !== 'win32') return { settleMs: 50, restoreMs: 100 };
  const executable = target.executablePath?.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return REMOTE_DESKTOP_CLIENTS.has(executable) ? { settleMs: 400, restoreMs: 3000 } : { settleMs: 50, restoreMs: 500 };
}

export function validatePasteTarget(
  startSnapshot: DictationTargetSnapshot | null,
  currentSnapshot: DictationTargetSnapshot | null
): { allowed: boolean; reason?: string } {
  if (!currentSnapshot) {
    return { allowed: false, reason: 'target-changed: foreground target is missing or invalid' };
  }

  // KDE Wayland targets are validated only by KdeWaylandDelivery.
  if (startSnapshot?.kind === 'kde-wayland' || currentSnapshot.kind === 'kde-wayland') {
    return { allowed: false, reason: 'target-changed: a Wayland window cannot be validated here' };
  }

  if (!startSnapshot) {
    return { allowed: true };
  }

  if (startSnapshot.kind !== currentSnapshot.kind || startSnapshot.processId !== currentSnapshot.processId) {
    return {
      allowed: false,
      reason: 'target-changed: focus moved to a different process',
    };
  }

  const sameWindow = startSnapshot.kind === 'win32' && currentSnapshot.kind === 'win32'
    ? startSnapshot.processCreationTime === currentSnapshot.processCreationTime
      && startSnapshot.hwnd === currentSnapshot.hwnd && startSnapshot.threadId === currentSnapshot.threadId
    : startSnapshot.kind === 'x11' && currentSnapshot.kind === 'x11'
      && startSnapshot.windowId === currentSnapshot.windowId && startSnapshot.processStartTime === currentSnapshot.processStartTime;
  if (!sameWindow) {
    return { allowed: false, reason: 'target-changed: the original window is no longer focused' };
  }
  return { allowed: true };
}

export class ClipboardTransactionManager {
  private queue: Promise<unknown> = Promise.resolve();
  private activeCount = 0;
  private delay: (ms: number) => Promise<void>;
  private onRestoreFailed: () => void;
  /** The clipboard a dispatched paste replaced, restored after the target has had time to read the transcript. */
  private pendingRestore: { snapshot: ClipboardSnapshot; sequence: number } | null = null;
  private restoreGeneration = 0;

  constructor(
    private clipboardIO: ClipboardIO,
    private foregroundInspector: ForegroundInspector,
    private inputSimulator: InputSimulator,
    private clipboardMonitor: ClipboardMonitor,
    private pasteStrategyResolver: PasteStrategyResolver,
    options: ClipboardTransactionManagerOptions = {}
  ) {
    this.delay = options.delayFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onRestoreFailed = options.onRestoreFailed ?? (() => undefined);
  }

  /** Restores a pending clipboard now, after any transaction in flight; called before quitting. */
  public flushRestore(): Promise<void> {
    return this.enqueue(() => {
      if (!this.restorePending()) this.onRestoreFailed();
    });
  }

  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const task = this.queue.then(fn);
    this.queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  /**
   * Returns false when the restore failed. The restore then stays pending, so no later snapshot mistakes the
   * transcript for the user's clipboard and writes it back where clipboard history keeps it.
   */
  private restorePending(): boolean {
    const pending = this.pendingRestore;
    if (!pending) return true;
    // 'changed' means a newer transcript or the user's later copy owns the clipboard: leave it.
    if (this.finalizeClipboard(pending.snapshot, pending.sequence) === 'failed') return false;
    this.pendingRestore = null;
    return true;
  }

  public async inject(
    text: string,
    options?: { target?: DictationTargetSnapshot | null; signal?: AbortSignal }
  ): Promise<InjectResult> {
    this.activeCount++;
    const task = this.queue.then(() => this.runInjection(text, options?.target, options?.signal));
    this.queue = task.then(
      () => {
        this.activeCount--;
      },
      () => {
        this.activeCount--;
      }
    );
    return task;
  }

  public async stage(text: string): Promise<void> {
    if (this.activeCount === 0) {
      this.clipboardIO.writeText(text);
      return;
    }
    return this.enqueue(() => this.clipboardIO.writeText(text));
  }

  private async runInjection(
    text: string,
    targetSnapshot: DictationTargetSnapshot | null = null,
    signal?: AbortSignal,
  ): Promise<InjectResult> {
    if (signal?.aborted) return { kind: 'input-blocked', acceptedEvents: 0, reason: 'Dictation was cancelled.' };
    let currentSnapshot: DictationTargetSnapshot | null;
    try {
      currentSnapshot = this.foregroundInspector();
    } catch (error) {
      console.warn('Failed to inspect foreground target:', error);
      return { kind: 'target-changed', reason: 'target-changed: foreground target inspection failed' };
    }

    const targetCheck = validatePasteTarget(targetSnapshot, currentSnapshot);
    if (!targetCheck.allowed) {
      return { kind: 'target-changed', reason: targetCheck.reason ?? 'target changed' };
    }

    const strategy = this.pasteStrategyResolver(
      currentSnapshot && currentSnapshot.kind !== 'kde-wayland' ? currentSnapshot.executablePath : null);
    const timings = pasteTimings(currentSnapshot);
    // ponytail: a valid next paste restores a waiting clipboard early, so a remote target still reading the
    // previous transcript within its 3 s grace gets the original clipboard; carry the snapshot across if
    // back-to-back RDP needs it.
    if (!this.restorePending()) {
      return { kind: 'input-blocked', acceptedEvents: 0,
        reason: 'The previous clipboard could not be restored, so this transcript was not pasted' };
    }

    let snapshot: ClipboardSnapshot | undefined;
    let sequenceAfterStage: number | undefined;
    let mayHavePasted = false;
    let result: InjectResult | undefined;

    try {
      result = await (async (): Promise<InjectResult> => {
        const sequenceBeforeCapture = this.clipboardMonitor();
        snapshot = this.clipboardIO.captureSnapshot();
        if (snapshot.skippedFormats?.length) {
          return { kind: 'input-blocked', acceptedEvents: 0,
            reason: 'The current clipboard cannot be fully preserved. Copy the transcript when ready to replace it.' };
        }
        if (sequenceBeforeCapture !== this.clipboardMonitor()) {
          return { kind: 'clipboard-conflict', reason: 'Clipboard contents changed during dictation' };
        }
        const staging = this.clipboardIO.writeTransientText(text, sequenceBeforeCapture);
        if (staging === 'changed') {
          return { kind: 'clipboard-conflict', reason: 'Clipboard contents changed during dictation' };
        }
        // Only a write that touched the clipboard may restore over it.
        sequenceAfterStage = this.clipboardMonitor();
        if (staging === 'cleared') {
          return { kind: 'error', message: 'Clipboard transaction failed: the transcript could not be staged' };
        }
        await this.delay(timings.settleMs);
        if (signal?.aborted) {
          return { kind: 'input-blocked', acceptedEvents: 0, reason: 'Dictation was cancelled.' };
        }
        if (sequenceAfterStage !== this.clipboardMonitor()) {
          return { kind: 'clipboard-conflict', reason: 'Clipboard contents changed during dictation' };
        }

        // Staging yields to other apps; validate again at the dispatch boundary.
        try {
          const dispatchTarget = this.foregroundInspector();
          const dispatchCheck = validatePasteTarget(currentSnapshot, dispatchTarget);
          if (!dispatchCheck.allowed) return { kind: 'target-changed', reason: dispatchCheck.reason ?? 'target changed' };
        } catch {
          return { kind: 'target-changed', reason: 'target-changed: foreground target inspection failed' };
        }
        let dispatchResult: PasteDispatchResult;
        const expectedEvents = buildPasteStrategyEvents(strategy).length;
        mayHavePasted = true;
        try {
          dispatchResult = this.inputSimulator(strategy);
          markTiming('paste-dispatched', { acceptedEvents: dispatchResult.acceptedEvents });
          // Without the paste key-down (the last key-down) nothing pasted, so don't leave the transcript
          // on the clipboard for a manual paste.
          if (dispatchResult.acceptedEvents < expectedEvents / 2) mayHavePasted = false;
        } catch (error) {
          return { kind: 'error', message: this.formatError('Paste dispatch failed', error) };
        }

        return this.buildDispatchResult(dispatchResult, expectedEvents);
      })();
    } catch (error) {
      result = { kind: 'error', message: this.formatError('Clipboard transaction failed', error) };
    } finally {
      if (snapshot !== undefined && sequenceAfterStage !== undefined) {
        this.pendingRestore = { snapshot, sequence: sequenceAfterStage };
        const generation = ++this.restoreGeneration;
        if (mayHavePasted) {
          // The target may read the clipboard long after SendInput returns, so the restore waits off the
          // delivery path; the next Dictation can start meanwhile.
          this.scheduleRestore(generation, timings.restoreMs, true);
        } else if (!this.restorePending()) {
          result = { kind: 'error', message: 'The clipboard could not be restored safely. Nothing was pasted; the transcript may still be on the clipboard.' };
        }
      }
    }

    return result ?? { kind: 'error', message: 'Unknown injection state' };
  }

  // A method, not a closure in runInjection, so a superseded timer captures only numbers and holds no snapshot.
  // A slow reader may still hold the clipboard when the timer fires, so a failed restore retries once before
  // telling the user.
  private scheduleRestore(generation: number, ms: number, retry: boolean): void {
    void this.delay(ms).then(() => this.enqueue(() => {
      if (this.restoreGeneration !== generation || this.restorePending()) return;
      if (retry) this.scheduleRestore(generation, RESTORE_RETRY_MS, false);
      else this.onRestoreFailed();
    })).catch((error: unknown) => console.warn('Clipboard restore failed:', error));
  }

  private buildDispatchResult(
    dispatchResult: PasteDispatchResult,
    expectedEvents: number
  ): InjectResult {
    if (dispatchResult.acceptedEvents === 0) {
      return {
        kind: 'input-blocked',
        acceptedEvents: 0,
        reason: dispatchResult.errorCode
          ? `No input events accepted (Win32 error ${dispatchResult.errorCode})`
          : 'No input events accepted',
      };
    }

    if (dispatchResult.acceptedEvents < expectedEvents) {
      return {
        kind: 'input-blocked',
        acceptedEvents: dispatchResult.acceptedEvents,
        reason: dispatchResult.errorCode
          ? `Partial input dispatch (Win32 error ${dispatchResult.errorCode})`
          : 'Partial input dispatch',
      };
    }

    return { kind: 'input-dispatched', acceptedEvents: dispatchResult.acceptedEvents };
  }

  private finalizeClipboard(
    snapshot: ClipboardSnapshot,
    sequenceAfterStage: number
  ): 'restored' | 'changed' | 'failed' {
    let sequenceBeforeRestore: number;
    try {
      sequenceBeforeRestore = this.clipboardMonitor();
    } catch {
      return 'failed';
    }

    if (sequenceBeforeRestore !== sequenceAfterStage) {
      return 'changed';
    }

    try {
      this.clipboardIO.restoreSnapshot(snapshot);
    } catch {
      return 'failed';
    }
    markTiming('clipboard-restored');
    return 'restored';
  }

  private formatError(context: string, error: unknown): string {
    const suffix = error instanceof Error ? error.message : String(error);
    return `${context}: ${suffix}`;
  }
}
