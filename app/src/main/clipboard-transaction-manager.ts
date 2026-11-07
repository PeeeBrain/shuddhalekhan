import type { DictationTargetSnapshot, PasteStrategy, InjectResult } from '../types/ipc';

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

export interface PasteDispatchResult {
  acceptedEvents: number;
  errorCode?: number;
}

export interface ClipboardIO {
  captureSnapshot(): ClipboardSnapshot;
  restoreSnapshot(snapshot: ClipboardSnapshot): void;
  writeText(text: string): void;
}

export interface ForegroundInspector {
  captureTarget(): DictationTargetSnapshot | null;
}

export interface InputSimulator {
  simulatePaste(strategy: PasteStrategy): PasteDispatchResult;
}

export interface ClipboardMonitor {
  getSequenceNumber(): number;
}

export interface PasteStrategyResolver {
  resolveStrategy(executablePath: string | null): PasteStrategy;
}

export interface ClipboardTransactionManagerOptions {
  stagingDelayMs?: number;
  pasteDelayMs?: number;
  delayFn?: (ms: number) => Promise<void>;
}

export function validatePasteTarget(
  startSnapshot: DictationTargetSnapshot | null,
  currentSnapshot: DictationTargetSnapshot | null
): { allowed: boolean; transition?: boolean; reason?: string } {
  if (!currentSnapshot) {
    return { allowed: false, reason: 'target-changed: foreground target is missing or invalid' };
  }

  // KDE Wayland targets are validated only by KdeWaylandDelivery.
  if (startSnapshot?.kind === 'kde-wayland' || currentSnapshot.kind === 'kde-wayland') {
    return { allowed: false, reason: 'target-changed: a Wayland window cannot be validated here' };
  }

  if (!startSnapshot) {
    return { allowed: true, transition: false };
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
  return { allowed: true, transition: false };
}

export class ClipboardTransactionManager {
  private queue: Promise<unknown> = Promise.resolve();
  private activeCount = 0;
  private stagingDelayMs: number;
  private pasteDelayMs: number;
  private delay: (ms: number) => Promise<void>;

  constructor(
    private clipboardIO: ClipboardIO,
    private foregroundInspector: ForegroundInspector,
    private inputSimulator: InputSimulator,
    private clipboardMonitor: ClipboardMonitor,
    private pasteStrategyResolver: PasteStrategyResolver,
    options: ClipboardTransactionManagerOptions = {}
  ) {
    this.stagingDelayMs = options.stagingDelayMs ?? 50;
    this.pasteDelayMs = options.pasteDelayMs ?? 100;
    this.delay = options.delayFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
    const task = this.queue.then(() => {
      this.clipboardIO.writeText(text);
    });
    this.queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private async runInjection(
    text: string,
    targetSnapshot: DictationTargetSnapshot | null = null,
    signal?: AbortSignal,
  ): Promise<InjectResult> {
    if (signal?.aborted) return { kind: 'input-blocked', acceptedEvents: 0, reason: 'Dictation was cancelled.' };
    let currentSnapshot: DictationTargetSnapshot | null;
    try {
      currentSnapshot = this.foregroundInspector.captureTarget();
    } catch (error) {
      console.warn('Failed to inspect foreground target:', error);
      return { kind: 'target-changed', reason: 'target-changed: foreground target inspection failed' };
    }

    const targetCheck = validatePasteTarget(targetSnapshot, currentSnapshot);
    if (!targetCheck.allowed) {
      return { kind: 'target-changed', reason: targetCheck.reason ?? 'target changed' };
    }

    const strategy = this.pasteStrategyResolver.resolveStrategy(
      currentSnapshot && currentSnapshot.kind !== 'kde-wayland' ? currentSnapshot.executablePath : null);

    let snapshot: ClipboardSnapshot | undefined;
    let sequenceAfterStage: number | undefined;
    let result: InjectResult | undefined;

    try {
      result = await (async (): Promise<InjectResult> => {
        const sequenceBeforeCapture = this.clipboardMonitor.getSequenceNumber();
        snapshot = this.clipboardIO.captureSnapshot();
        if (snapshot.skippedFormats?.length) {
          return { kind: 'input-blocked', acceptedEvents: 0,
            reason: 'The current clipboard cannot be fully preserved. Copy the transcript when ready to replace it.' };
        }
        if (sequenceBeforeCapture !== this.clipboardMonitor.getSequenceNumber()) {
          return { kind: 'clipboard-conflict', reason: 'Clipboard contents changed during dictation' };
        }
        this.clipboardIO.writeText(text);
        sequenceAfterStage = this.clipboardMonitor.getSequenceNumber();
        await this.delay(this.stagingDelayMs);
        if (signal?.aborted) {
          return { kind: 'input-blocked', acceptedEvents: 0, reason: 'Dictation was cancelled.' };
        }
        if (sequenceAfterStage !== this.clipboardMonitor.getSequenceNumber()) {
          return { kind: 'clipboard-conflict', reason: 'Clipboard contents changed during dictation' };
        }

        // Staging yields to other apps; validate again at the dispatch boundary.
        try {
          const dispatchTarget = this.foregroundInspector.captureTarget();
          const dispatchCheck = validatePasteTarget(currentSnapshot, dispatchTarget);
          if (!dispatchCheck.allowed) return { kind: 'target-changed', reason: dispatchCheck.reason ?? 'target changed' };
        } catch {
          return { kind: 'target-changed', reason: 'target-changed: foreground target inspection failed' };
        }
        let dispatchResult: PasteDispatchResult;
        try {
          dispatchResult = this.inputSimulator.simulatePaste(strategy);
        } catch (error) {
          return { kind: 'error', message: this.formatError('Paste dispatch failed', error) };
        }
        await this.delay(this.pasteDelayMs);

        return this.buildDispatchResult(dispatchResult, strategy);
      })();
    } catch (error) {
      result = { kind: 'error', message: this.formatError('Clipboard transaction failed', error) };
    } finally {
      if (snapshot !== undefined && sequenceAfterStage !== undefined) {
        const restoration = await this.finalizeClipboard(snapshot, sequenceAfterStage);
        if (restoration === 'failed') {
          result = { kind: 'error', message: 'The clipboard could not be restored safely. Check the destination; input may already have been sent.' };
        } else if (restoration === 'changed' && result?.kind === 'input-dispatched') {
          result = {
            kind: 'clipboard-conflict',
            reason: 'Clipboard contents changed during dictation',
          };
        }
      }
    }

    return result ?? { kind: 'error', message: 'Unknown injection state' };
  }

  private buildDispatchResult(
    dispatchResult: PasteDispatchResult,
    strategy: PasteStrategy
  ): InjectResult {
    const expectedEvents = strategy === 'ctrl-shift-v' ? 6 : 4;

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

  private async finalizeClipboard(
    snapshot: ClipboardSnapshot,
    sequenceAfterStage: number
  ): Promise<'restored' | 'changed' | 'failed'> {
    let sequenceBeforeRestore: number;
    try {
      sequenceBeforeRestore = this.clipboardMonitor.getSequenceNumber();
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
    return 'restored';
  }

  private formatError(context: string, error: unknown): string {
    const suffix = error instanceof Error ? error.message : String(error);
    return `${context}: ${suffix}`;
  }
}
