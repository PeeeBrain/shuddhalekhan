import { describe, expect, it, mock, beforeEach } from 'bun:test';
import {
  ClipboardTransactionManager,
  type ClipboardIO,
  type ForegroundInspector,
  type InputSimulator,
  type ClipboardMonitor,
  type PasteStrategyResolver,
  type ClipboardSnapshot,
} from '../clipboard-transaction-manager';
import type { DictationTargetSnapshot } from '../../types/ipc';

const defaultTarget: DictationTargetSnapshot = {
  hwnd: 12345,
  processId: 67890,
  threadId: 111,
  windowClass: 'Notepad',
  executablePath: 'C:\\Windows\\notepad.exe',
  capturedAt: new Date().toISOString(),
};

function createClipboardSnapshot(overrides: Partial<ClipboardSnapshot> = {}): ClipboardSnapshot {
  return { wasEmpty: false, text: 'original clipboard', skippedFormats: [], ...overrides };
}

describe('ClipboardTransactionManager', () => {
  let mockClipboardIO: ClipboardIO;
  let mockForegroundInspector: ForegroundInspector;
  let mockInputSimulator: InputSimulator;
  let mockClipboardMonitor: ClipboardMonitor;
  let mockPasteStrategyResolver: PasteStrategyResolver;
  let mockDelay: ReturnType<typeof mock>;

  beforeEach(() => {
    mockClipboardIO = {
      captureSnapshot: mock(() => createClipboardSnapshot()),
      restoreSnapshot: mock(() => undefined),
      writeText: mock(() => undefined),
    };

    mockForegroundInspector = {
      captureTarget: mock(() => defaultTarget),
    };

    mockInputSimulator = {
      simulatePaste: mock(() => ({ acceptedEvents: 4 })),
    };

    mockClipboardMonitor = {
      getSequenceNumber: mock(() => 1),
    };

    mockPasteStrategyResolver = {
      resolveStrategy: mock(() => 'ctrl-v'),
    };

    mockDelay = mock(async () => undefined);
  });

  function createManager(options: { stagingDelayMs?: number; pasteDelayMs?: number } = {}) {
    return new ClipboardTransactionManager(
      mockClipboardIO,
      mockForegroundInspector,
      mockInputSimulator,
      mockClipboardMonitor,
      mockPasteStrategyResolver,
      {
        stagingDelayMs: options.stagingDelayMs ?? 10,
        pasteDelayMs: options.pasteDelayMs ?? 10,
        delayFn: mockDelay,
      }
    );
  }

  it('runs basic injection successfully', async () => {
    const manager = createManager();
    const result = await manager.inject('hello');

    expect(result).toEqual({ kind: 'input-dispatched', acceptedEvents: 4 });
    expect(mockForegroundInspector.captureTarget).toHaveBeenCalledTimes(1);
    expect(mockClipboardIO.captureSnapshot).toHaveBeenCalledTimes(1);
    expect(mockClipboardIO.writeText).toHaveBeenCalledWith('hello');
    expect(mockClipboardMonitor.getSequenceNumber).toHaveBeenCalledTimes(2);
    expect(mockDelay).toHaveBeenNthCalledWith(1, 10);
    expect(mockDelay).toHaveBeenNthCalledWith(2, 10);
    expect(mockInputSimulator.simulatePaste).toHaveBeenCalledWith('ctrl-v');
    expect(mockClipboardIO.restoreSnapshot).toHaveBeenCalledTimes(1);
  });

  it('returns target-changed if foreground target is missing', async () => {
    mockForegroundInspector.captureTarget = mock(() => null);
    const manager = createManager();

    const result = await manager.inject('hello', { target: defaultTarget });

    expect(result.kind).toBe('target-changed');
    expect(mockInputSimulator.simulatePaste).not.toHaveBeenCalled();
    expect(mockClipboardIO.restoreSnapshot).not.toHaveBeenCalled();
  });

  it('returns target-changed if focus moved to a different process', async () => {
    mockForegroundInspector.captureTarget = mock(() => ({
      ...defaultTarget,
      processId: 99999, // Different process
    }));
    const manager = createManager();

    const result = await manager.inject('hello', { target: defaultTarget });

    expect(result).toEqual({
      kind: 'target-changed',
      reason: 'target-changed: focus moved to a different process',
    });
    expect(mockInputSimulator.simulatePaste).not.toHaveBeenCalled();
  });

  it('allows injection if focus changed to another window within the same process', async () => {
    mockForegroundInspector.captureTarget = mock(() => ({
      ...defaultTarget,
      hwnd: 54321, // Different window
    }));
    const manager = createManager();

    const result = await manager.inject('hello', { target: defaultTarget });

    expect(result).toEqual({ kind: 'input-dispatched', acceptedEvents: 4 });
    expect(mockInputSimulator.simulatePaste).toHaveBeenCalledTimes(1);
  });

  it('stages text cleanly without restoring snapshot', async () => {
    const manager = createManager();
    await manager.stage('recovery text');

    expect(mockClipboardIO.writeText).toHaveBeenCalledWith('recovery text');
    expect(mockClipboardIO.restoreSnapshot).not.toHaveBeenCalled();
  });

  it('serializes concurrent inject and stage operations (FIFO queue)', async () => {
    const executionOrder: string[] = [];

    mockClipboardIO.writeText = mock((text: string) => {
      executionOrder.push(`write:${text}`);
    });

    mockInputSimulator.simulatePaste = mock(() => {
      executionOrder.push('paste');
      return { acceptedEvents: 4 };
    });

    mockClipboardIO.restoreSnapshot = mock(() => {
      executionOrder.push('restore');
    });

    const manager = createManager();

    // Fire inject and stage concurrently
    const p1 = manager.inject('first');
    const p2 = manager.stage('second');
    const p3 = manager.inject('third');

    await Promise.all([p1, p2, p3]);

    // First injection should write, paste, and restore.
    // Then second staging should write.
    // Then third injection should write, paste, and restore.
    expect(executionOrder).toEqual([
      'write:first',
      'paste',
      'restore',
      'write:second',
      'write:third',
      'paste',
      'restore',
    ]);
  });

  it('detects clipboard conflicts and returns clipboard-conflict result without restoring', async () => {
    let callCount = 0;
    mockClipboardMonitor.getSequenceNumber = mock(() => {
      callCount++;
      // Return 1 after staging, but 2 when verifying before restoring
      return callCount === 1 ? 1 : 2;
    });

    const manager = createManager();
    const result = await manager.inject('hello');

    expect(result).toEqual({
      kind: 'clipboard-conflict',
      reason: 'Clipboard contents changed during dictation',
    });
    expect(mockClipboardIO.restoreSnapshot).not.toHaveBeenCalled();
  });

  it('returns input-blocked when zero events are accepted', async () => {
    mockInputSimulator.simulatePaste = mock(() => ({ acceptedEvents: 0, errorCode: 5 }));

    const manager = createManager();
    const result = await manager.inject('hello');

    expect(result).toEqual({
      kind: 'input-blocked',
      acceptedEvents: 0,
      reason: 'No input events accepted (Win32 error 5)',
    });
    expect(mockClipboardIO.restoreSnapshot).toHaveBeenCalledTimes(1);
  });

  it('returns input-blocked with diagnostics on partial events accepted', async () => {
    mockInputSimulator.simulatePaste = mock(() => ({ acceptedEvents: 2 }));

    const manager = createManager();
    const result = await manager.inject('hello');

    expect(result).toEqual({
      kind: 'input-blocked',
      acceptedEvents: 2,
      reason: 'Partial input dispatch',
    });
    expect(mockClipboardIO.restoreSnapshot).toHaveBeenCalledTimes(1);
  });

  it('restores the clipboard when paste dispatch throws', async () => {
    mockInputSimulator.simulatePaste = mock(() => {
      throw new Error('SendInput failed');
    });

    const manager = createManager();
    const result = await manager.inject('hello');

    expect(result).toEqual({
      kind: 'error',
      message: 'Paste dispatch failed: SendInput failed',
    });
    expect(mockClipboardIO.restoreSnapshot).toHaveBeenCalledWith(
      createClipboardSnapshot()
    );
  });

  it('returns target-changed when inspecting the current foreground target fails/throws', async () => {
    mockForegroundInspector.captureTarget = mock(() => {
      throw new Error('user32 read failed');
    });

    const manager = createManager();
    const result = await manager.inject('hello', { target: defaultTarget });

    expect(result).toEqual({
      kind: 'target-changed',
      reason: 'target-changed: foreground target inspection failed',
    });
    expect(mockInputSimulator.simulatePaste).not.toHaveBeenCalled();
  });
});
