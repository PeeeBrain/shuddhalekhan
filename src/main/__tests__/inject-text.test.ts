import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { ClipboardTransactionManager } from '../clipboard-transaction-manager';
import type { DictationTargetSnapshot } from '../../types/ipc';

// Mock production adapters so they don't load Electron or Koffi native modules
mock.module('../production-adapters', () => ({
  ElectronClipboardAdapter: class {},
  Win32ForegroundInspector: class {},
  Win32InputSimulator: class {},
  Win32ClipboardMonitor: class {},
  ConfigPasteStrategyResolver: class {},
}));

const defaultTarget: DictationTargetSnapshot = {
  hwnd: 12345,
  processId: 67890,
  threadId: 111,
  windowClass: 'Notepad',
  executablePath: 'C:\\Windows\\notepad.exe',
  capturedAt: new Date().toISOString(),
};

describe('inject-text integration', () => {
  let injectIntoFocusedApp: any;
  let copyLastTranscriptToClipboard: any;
  let getClipboardTransactionManager: any;

  beforeEach(async () => {
    const mod = await import('../inject-text');
    injectIntoFocusedApp = mod.injectIntoFocusedApp;
    copyLastTranscriptToClipboard = mod.copyLastTranscriptToClipboard;
    getClipboardTransactionManager = mod.getClipboardTransactionManager;
  });

  it('getClipboardTransactionManager returns a valid manager instance', () => {
    const manager = getClipboardTransactionManager();
    expect(manager).toBeInstanceOf(ClipboardTransactionManager);
    expect(getClipboardTransactionManager()).toBe(manager); // singleton check
  });

  it('injectIntoFocusedApp delegates to the provided manager', async () => {
    const fakeResult = { kind: 'input-dispatched' as const, acceptedEvents: 4 };
    const mockManager = {
      inject: mock(async () => fakeResult),
      stage: mock(async () => undefined),
    } as unknown as ClipboardTransactionManager;

    const result = await injectIntoFocusedApp('test text', defaultTarget, mockManager);

    expect(result).toEqual(fakeResult);
    expect(mockManager.inject).toHaveBeenCalledWith('test text', { target: defaultTarget });
  });

  it('copyLastTranscriptToClipboard delegates to the provided manager', async () => {
    const mockManager = {
      inject: mock(async () => ({ kind: 'input-dispatched' as const, acceptedEvents: 4 })),
      stage: mock(async () => undefined),
    } as unknown as ClipboardTransactionManager;

    await copyLastTranscriptToClipboard('stage text', mockManager);

    expect(mockManager.stage).toHaveBeenCalledWith('stage text');
  });
});
