import {
  ClipboardTransactionManager,
} from './clipboard-transaction-manager';
import {
  ElectronClipboardAdapter,
  NativeForegroundInspector,
  NativeInputSimulator,
  NativeClipboardMonitor,
  ConfigPasteStrategyResolver,
} from './production-adapters';
import type { DictationTargetSnapshot, InjectResult } from '../types/ipc';

export { validatePasteTarget } from './clipboard-transaction-manager';

let defaultManager: ClipboardTransactionManager | null = null;

export function getClipboardTransactionManager(): ClipboardTransactionManager {
  if (!defaultManager) {
    defaultManager = new ClipboardTransactionManager(
      new ElectronClipboardAdapter(),
      new NativeForegroundInspector(),
      new NativeInputSimulator(),
      new NativeClipboardMonitor(),
      new ConfigPasteStrategyResolver()
    );
  }
  return defaultManager;
}

export async function injectIntoFocusedApp(
  text: string,
  targetSnapshot: DictationTargetSnapshot | null = null,
  manager = getClipboardTransactionManager(),
  signal?: AbortSignal,
): Promise<InjectResult> {
  return manager.inject(text, { target: targetSnapshot, signal });
}

export async function copyLastTranscriptToClipboard(
  text: string,
  manager = getClipboardTransactionManager()
): Promise<void> {
  await manager.stage(text);
}
