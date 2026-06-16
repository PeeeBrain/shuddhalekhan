import { clipboard } from 'electron';
import { simulatePaste } from './native/clipboard';
import type { PasteDispatchResult } from './native/clipboard';
import type { InjectResult } from '../types/ipc';

export type { InjectResult };

interface InjectTextDeps {
  readText: () => string;
  writeText: (text: string) => void;
  simulatePaste: () => PasteDispatchResult;
  delay: (ms: number) => Promise<void>;
}

const defaultDeps: InjectTextDeps = {
  readText: () => clipboard.readText(),
  writeText: (text) => clipboard.writeText(text),
  simulatePaste,
  delay,
};

let injectionQueue: Promise<unknown> = Promise.resolve();

export async function injectIntoFocusedApp(text: string, deps: InjectTextDeps = defaultDeps): Promise<InjectResult> {
  const task = injectionQueue.then(() => runInjection(text, deps));
  injectionQueue = task.catch(() => undefined);
  return task;
}

export function copyLastTranscriptToClipboard(text: string, deps: InjectTextDeps = defaultDeps): void {
  deps.writeText(text);
}

async function runInjection(text: string, deps: InjectTextDeps): Promise<InjectResult> {
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
    dispatchResult = deps.simulatePaste();
  } catch (error) {
    await restoreClipboard(originalClipboard, deps);
    return { kind: 'error', message: formatError('Paste dispatch failed', error) };
  }

  await deps.delay(100);
  await restoreClipboard(originalClipboard, deps);

  if (dispatchResult.acceptedEvents === 0) {
    return {
      kind: 'input-blocked',
      acceptedEvents: 0,
      reason: dispatchResult.errorCode
        ? `No input events accepted (Win32 error ${dispatchResult.errorCode})`
        : 'No input events accepted',
    };
  }

  if (dispatchResult.acceptedEvents < 4) {
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
