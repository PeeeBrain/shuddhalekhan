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
      resolveConfiguredPasteStrategy
    );
  }
  return defaultManager;
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
