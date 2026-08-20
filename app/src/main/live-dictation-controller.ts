import type { DictationTargetSnapshot } from '../types/ipc';
import {
  computeCommittedDelta,
  exceedsUnicodeDispatchLimit,
  hasMalformedControlCharacters,
  validateExactTarget,
} from '../shared/live-dictation';
import type { UnicodeDispatchResult } from './native/unicode-input';

export type LiveInsertionHaltReason =
  | 'target-changed'
  | 'malformed-control'
  | 'oversized-delta'
  | 'partial-dispatch'
  | 'zero-dispatch'
  | 'keyboard-timeout'
  | 'session-invalidated';

export interface LiveDictationSessionState {
  halted: boolean;
  haltReason: LiveInsertionHaltReason | null;
  uncertain: boolean;
  dispatchedProjectedLength: number;
  rawCommitted: string;
  hasAcceptedEvents: boolean;
}

export interface LiveDictationControllerDeps {
  originalTarget: DictationTargetSnapshot;
  captureTarget: () => DictationTargetSnapshot | null;
  isKeyboardClear: () => boolean;
  dispatchUnicode: (text: string) => UnicodeDispatchResult;
  onHalted?: (reason: LiveInsertionHaltReason) => void;
}

export class LiveDictationController {
  private halted = false;
  private haltReason: LiveInsertionHaltReason | null = null;
  private uncertain = false;
  private dispatchedProjectedLength = 0;
  private rawCommitted = '';
  private hasAcceptedEvents = false;
  private queue: Promise<void> = Promise.resolve();
  private invalidated = false;

  constructor(private readonly deps: LiveDictationControllerDeps) {}

  getState(): LiveDictationSessionState {
    return {
      halted: this.halted,
      haltReason: this.haltReason,
      uncertain: this.uncertain,
      dispatchedProjectedLength: this.dispatchedProjectedLength,
      rawCommitted: this.rawCommitted,
      hasAcceptedEvents: this.hasAcceptedEvents,
    };
  }

  invalidate(): void {
    this.invalidated = true;
    this.halted = true;
    this.haltReason = 'session-invalidated';
  }

  async onCommittedUpdate(rawCommitted: string): Promise<void> {
    if (this.invalidated) return;
    this.rawCommitted = rawCommitted;
    if (this.halted) return;
    if (hasMalformedControlCharacters(rawCommitted)) {
      this.halt('malformed-control');
      return;
    }
    await this.enqueueDispatch(false);
  }

  async onKeyboardStateChanged(): Promise<void> {
    if (this.invalidated || this.halted) return;
    await this.enqueueDispatch(false);
  }

  async finalize(rawCommitted: string): Promise<void> {
    if (this.invalidated) return;
    this.rawCommitted = rawCommitted;
    if (this.halted) return;
    if (hasMalformedControlCharacters(rawCommitted)) {
      this.halt('malformed-control');
      return;
    }
    await this.enqueueDispatch(true);
  }

  private enqueueDispatch(finalizing: boolean): Promise<void> {
    this.queue = this.queue.then(() => this.dispatchPending(finalizing));
    return this.queue;
  }

  private async dispatchPending(finalizing: boolean): Promise<void> {
    if (this.invalidated || this.halted) return;
    if (!this.deps.isKeyboardClear() && !finalizing) return;

    while (true) {
      const delta = computeCommittedDelta(
        this.rawCommitted,
        this.dispatchedProjectedLength,
        { finalizing },
      );
      if (!delta) return;

      if (exceedsUnicodeDispatchLimit(delta)) {
        this.halt('oversized-delta');
        return;
      }

      const validation = validateExactTarget(this.deps.originalTarget, this.deps.captureTarget());
      if (!validation.allowed) {
        this.halt('target-changed');
        return;
      }

      const result = this.deps.dispatchUnicode(delta);
      if (result.certainty === 'ambiguous-partial') {
        this.uncertain = true;
        this.halt('partial-dispatch');
        return;
      }
      if (result.certainty === 'none-accepted') {
        this.halt('zero-dispatch');
        return;
      }

      this.hasAcceptedEvents = true;
      this.dispatchedProjectedLength += delta.length;

      const nextDelta = computeCommittedDelta(
        this.rawCommitted,
        this.dispatchedProjectedLength,
        { finalizing },
      );
      if (!nextDelta) return;
    }
  }

  private halt(reason: LiveInsertionHaltReason): void {
    this.halted = true;
    this.haltReason = reason;
    this.deps.onHalted?.(reason);
  }
}
