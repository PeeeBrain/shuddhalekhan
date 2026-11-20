import { Notification } from 'electron';
import {
  ClipboardTransactionManager,
} from './clipboard-transaction-manager';
import {
  ElectronClipboardAdapter,
  resolveConfiguredPasteStrategy,
} from './production-adapters';
import type { DictationTargetSnapshot, InjectResult } from '../types/ipc';

import { captureForegroundTarget } from './native/target';
import { simulatePaste, getClipboardSequenceNumber } from './native/clipboard';

let defaultManager: ClipboardTransactionManager | null = null;

export function getClipboardTransactionManager(): ClipboardTransactionManager {
  if (!defaultManager) {
    defaultManager = new ClipboardTransactionManager(
      new ElectronClipboardAdapter(),
      captureForegroundTarget,
      simulatePaste,
      getClipboardSequenceNumber,
      resolveConfiguredPasteStrategy,
      { onRestoreFailed: showRestoreFailure }
    );
  }
  return defaultManager;
}

function showRestoreFailure(): void {
  console.warn('Dictation: the previous clipboard could not be restored after pasting.');
  if (!Notification.isSupported()) return;
  new Notification({
    title: 'Clipboard Not Restored',
    body: 'Your previous clipboard could not be restored after pasting. The transcript may still be on the clipboard.',
    silent: true,
  }).show();
}

/** Puts back a clipboard still waiting to be restored, so quitting never leaves the transcript on it. */
export async function restorePendingClipboard(): Promise<void> {
  await defaultManager?.flushRestore();
}

export async function injectIntoFocusedApp(
  text: string,
  targetSnapshot: DictationTargetSnapshot | null = null,
  signal?: AbortSignal,
): Promise<InjectResult> {
  return getClipboardTransactionManager().inject(text, { target: targetSnapshot, signal });
}

export async function copyLastTranscriptToClipboard(text: string): Promise<void> {
  await getClipboardTransactionManager().stage(text);
}
