import { clipboard } from 'electron';
import { simulatePaste } from './native/clipboard';
import { captureForegroundTarget } from './native/target';
import { resolvePasteStrategy } from './paste-strategy';
import { getConfig } from './config';
import type { PasteDispatchResult } from './native/clipboard';
import type {
  DictationTargetSnapshot,
  InjectResult,
  PasteStrategy,
  PasteStrategyConfig,
} from '../types/ipc';

export type { InjectResult };

export interface TargetValidationResult {
  allowed: boolean;
  transition?: boolean;
  reason?: string;
}

interface InjectTextDeps {
  readText: () => string;
  writeText: (text: string) => void;
  simulatePaste: (strategy: PasteStrategy) => PasteDispatchResult;
  captureTarget: () => DictationTargetSnapshot | null;
  resolvePasteStrategy: (executablePath: string | null, config: PasteStrategyConfig) => PasteStrategy;
  getPasteStrategyConfig: () => PasteStrategyConfig;
  delay: (ms: number) => Promise<void>;
}

const defaultDeps: InjectTextDeps = {
  readText: () => clipboard.readText(),
  writeText: (text) => clipboard.writeText(text),
  simulatePaste,
  captureTarget: captureForegroundTarget,
  resolvePasteStrategy,
  getPasteStrategyConfig: () => getConfig().pasteStrategy,
  delay,
};

let injectionQueue: Promise<unknown> = Promise.resolve();

export async function injectIntoFocusedApp(
  text: string,
  targetSnapshot: DictationTargetSnapshot | null = null,
  deps: InjectTextDeps = defaultDeps
): Promise<InjectResult> {
  const task = injectionQueue.then(() => runInjection(text, targetSnapshot, deps));
  injectionQueue = task.catch(() => undefined);
  return task;
}

export function copyLastTranscriptToClipboard(text: string, deps: Partial<InjectTextDeps> = {}): void {
  const writeText = deps.writeText ?? defaultDeps.writeText;
  writeText(text);
}

export function validatePasteTarget(
  startSnapshot: DictationTargetSnapshot | null,
  currentSnapshot: DictationTargetSnapshot | null
): TargetValidationResult {
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

async function runInjection(
  text: string,
  targetSnapshot: DictationTargetSnapshot | null,
  deps: InjectTextDeps
): Promise<InjectResult> {
  let currentSnapshot: DictationTargetSnapshot | null;
  try {
    currentSnapshot = deps.captureTarget();
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

  const strategyConfig = deps.getPasteStrategyConfig();
  const strategy = deps.resolvePasteStrategy(currentSnapshot?.executablePath ?? null, strategyConfig);

  let originalClipboard: string;
  try {
    originalClipboard = deps.readText();
  } catch (error) {
    return { kind: 'error', message: formatError('Failed to read clipboard', error) };
  }

  try {
    deps.writeText(text);
  } catch (error) {
    return { kind: 'error', message: formatError('Failed to stage clipboard', error) };
  }

  await deps.delay(50);

  let dispatchResult: PasteDispatchResult;
  try {
    dispatchResult = deps.simulatePaste(strategy);
  } catch (error) {
    await restoreClipboard(originalClipboard, deps);
    return { kind: 'error', message: formatError('Paste dispatch failed', error) };
  }

  await deps.delay(100);
  await restoreClipboard(originalClipboard, deps);

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

async function restoreClipboard(originalClipboard: string, deps: InjectTextDeps): Promise<void> {
  if (!originalClipboard) return;
  try {
    deps.writeText(originalClipboard);
  } catch {
    // Preserve the original failure mode; restoration failure is not recoverable here.
  }
}

function formatError(context: string, error: unknown): string {
  const suffix = error instanceof Error ? error.message : String(error);
  return `${context}: ${suffix}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
