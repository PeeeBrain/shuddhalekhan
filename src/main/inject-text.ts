import {
  ClipboardTransactionManager,
} from './clipboard-transaction-manager';
import {
  ElectronClipboardAdapter,
  Win32ForegroundInspector,
  Win32InputSimulator,
  Win32ClipboardMonitor,
  ConfigPasteStrategyResolver,
} from './production-adapters';
import type { DictationTargetSnapshot, InjectResult } from '../types/ipc';

export { validatePasteTarget } from './clipboard-transaction-manager';

let defaultManager: ClipboardTransactionManager | null = null;

export function getClipboardTransactionManager(): ClipboardTransactionManager {
  if (!defaultManager) {
    defaultManager = new ClipboardTransactionManager(
      new ElectronClipboardAdapter(),
      new Win32ForegroundInspector(),
      new Win32InputSimulator(),
      new Win32ClipboardMonitor(),
      new ConfigPasteStrategyResolver()
    );
  }
  return defaultManager;
}

export async function injectIntoFocusedApp(
  text: string,
  targetSnapshot: DictationTargetSnapshot | null = null,
  manager = getClipboardTransactionManager()
): Promise<InjectResult> {
  return manager.inject(text, { target: targetSnapshot });
}

export async function copyLastTranscriptToClipboard(
  text: string,
  manager = getClipboardTransactionManager()
): Promise<void> {
  await manager.stage(text);
}
