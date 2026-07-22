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

  if (!startSnapshot) {
    return { allowed: true, transition: false };
  }

  if (startSnapshot.processId !== currentSnapshot.processId) {
    return {
      allowed: false,
      reason: 'target-changed: focus moved to a different process',
    };
  }

  const transition = startSnapshot.hwnd !== currentSnapshot.hwnd;
  return { allowed: true, transition };
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
    options?: { target?: DictationTargetSnapshot | null }
  ): Promise<InjectResult> {
    this.activeCount++;
    const task = this.queue.then(() => this.runInjection(text, options?.target));
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
    targetSnapshot: DictationTargetSnapshot | null = null
  ): Promise<InjectResult> {
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

    if (targetCheck.transition) {
      console.log(
        'Dictation target transitioned within the same process',
        JSON.stringify({
          startHwnd: targetSnapshot?.hwnd,
          currentHwnd: currentSnapshot?.hwnd,
          processId: currentSnapshot?.processId,
          executable: currentSnapshot?.executablePath
            ? currentSnapshot.executablePath.split(/[\\/]/).pop()
            : null,
        })
      );
    }

    const strategy = this.pasteStrategyResolver.resolveStrategy(currentSnapshot?.executablePath ?? null);

    let snapshot: ClipboardSnapshot | undefined;
    let sequenceAfterStage: number | undefined;
    let result: InjectResult | undefined;

    try {
      snapshot = this.clipboardIO.captureSnapshot();
      this.clipboardIO.writeText(text);
      sequenceAfterStage = this.clipboardMonitor.getSequenceNumber();

      await this.delay(this.stagingDelayMs);

      let dispatchResult: PasteDispatchResult;
      try {
        dispatchResult = this.inputSimulator.simulatePaste(strategy);
      } catch (error) {
        result = { kind: 'error', message: this.formatError('Paste dispatch failed', error) };
        return result;
      }

      await this.delay(this.pasteDelayMs);

      result = this.buildDispatchResult(dispatchResult, strategy);
    } catch (error) {
      result = { kind: 'error', message: this.formatError('Clipboard transaction failed', error) };
    } finally {
      if (snapshot !== undefined && sequenceAfterStage !== undefined) {
        const conflict = await this.finalizeClipboard(snapshot, sequenceAfterStage);
        if (conflict && result?.kind === 'input-dispatched') {
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
  ): Promise<boolean> {
    let sequenceBeforeRestore: number;
    try {
      sequenceBeforeRestore = this.clipboardMonitor.getSequenceNumber();
    } catch {
      return false;
    }

    if (sequenceBeforeRestore !== sequenceAfterStage) {
      return true;
    }

    try {
      this.clipboardIO.restoreSnapshot(snapshot);
    } catch {
      // Ignore restore failures to preserve primary failure reason
    }
    return false;
  }

  private formatError(context: string, error: unknown): string {
    const suffix = error instanceof Error ? error.message : String(error);
    return `${context}: ${suffix}`;
  }
}
