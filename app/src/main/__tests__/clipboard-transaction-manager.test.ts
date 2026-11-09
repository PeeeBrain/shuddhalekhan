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
  kind: 'win32',
  hwnd: 12345,
  processId: 67890,
  processCreationTime: '2026-01-01T00:00:00.000Z',
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
  let mockForegroundInspector: { captureTarget: ForegroundInspector };
  let mockInputSimulator: { simulatePaste: InputSimulator };
  let mockClipboardMonitor: { getSequenceNumber: ClipboardMonitor };
  let mockPasteStrategyResolver: { resolveStrategy: PasteStrategyResolver };
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

  function createManager() {
    return new ClipboardTransactionManager(
      mockClipboardIO,
      () => mockForegroundInspector.captureTarget(),
      strategy => mockInputSimulator.simulatePaste(strategy),
      () => mockClipboardMonitor.getSequenceNumber(),
      executable => mockPasteStrategyResolver.resolveStrategy(executable),
      {
        delayFn: mockDelay,
      }
    );
  }

  it('runs basic injection successfully', async () => {
    const manager = createManager();
    const result = await manager.inject('hello');

    expect(result).toEqual({ kind: 'input-dispatched', acceptedEvents: 4 });
    expect(mockClipboardIO.captureSnapshot).toHaveBeenCalledTimes(1);
    expect(mockClipboardIO.writeText).toHaveBeenCalledWith('hello');
    expect(mockClipboardMonitor.getSequenceNumber).toHaveBeenCalledTimes(5);
    expect(mockDelay).toHaveBeenNthCalledWith(1, 50);
    expect(mockDelay).toHaveBeenNthCalledWith(2, 100);
    expect(mockInputSimulator.simulatePaste).toHaveBeenCalledWith('ctrl-v');
    expect(mockClipboardIO.restoreSnapshot).toHaveBeenCalledTimes(1);
  });

  it('cancels during clipboard staging without dispatching input and restores the original clipboard', async () => {
    const controller = new AbortController();
    mockDelay = mock(async () => { controller.abort(); });
    const result = await createManager().inject('cancelled text', { target: defaultTarget, signal: controller.signal });
    expect(result).toMatchObject({ kind: 'input-blocked', acceptedEvents: 0 });
    expect(mockInputSimulator.simulatePaste).not.toHaveBeenCalled();
    expect(mockClipboardIO.restoreSnapshot).toHaveBeenCalledWith(createClipboardSnapshot());
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

  it('blocks paste when the original process ID is reused by a new process', async () => {
    mockForegroundInspector.captureTarget = mock(() => ({
      ...defaultTarget, processCreationTime: '2026-01-01T00:00:01.000Z',
    }));

    const result = await createManager().inject('private transcript', { target: defaultTarget });

    expect(result.kind).toBe('target-changed');
    expect(mockInputSimulator.simulatePaste).not.toHaveBeenCalled();
    expect(mockClipboardIO.writeText).not.toHaveBeenCalled();
  });

  it('blocks injection into another window within the same process', async () => {
    mockForegroundInspector.captureTarget = mock(() => ({
      ...defaultTarget,
      hwnd: 54321, // Different window
    }));
    const manager = createManager();

    const result = await manager.inject('hello', { target: defaultTarget });

    expect(result.kind).toBe('target-changed');
    expect(mockInputSimulator.simulatePaste).not.toHaveBeenCalled();
  });

  for (const target of [defaultTarget, null]) {
    it(`blocks a process switch during staging for ${target ? 'recorded' : 'manual'} paste`, async () => {
      let foreground = defaultTarget;
      mockForegroundInspector.captureTarget = mock(() => foreground);
      mockDelay = mock(async () => {
        foreground = { ...defaultTarget, processId: 99999 };
      });

      const result = await createManager().inject('hello', { target });

      expect(result.kind).toBe('target-changed');
      expect(mockInputSimulator.simulatePaste).not.toHaveBeenCalled();
      expect(mockClipboardIO.restoreSnapshot).toHaveBeenCalledWith(createClipboardSnapshot());
    });
  }

  it('blocks dispatch when foreground inspection fails after staging', async () => {
    let stagingFinished = false;
    mockDelay = mock(async () => { stagingFinished = true; });
    mockForegroundInspector.captureTarget = mock(() => {
      if (stagingFinished) throw new Error('foreground unavailable');
      return defaultTarget;
    });

    const result = await createManager().inject('hello', { target: defaultTarget });

    expect(result.kind).toBe('target-changed');
    expect(mockInputSimulator.simulatePaste).not.toHaveBeenCalled();
    expect(mockClipboardIO.restoreSnapshot).toHaveBeenCalledWith(createClipboardSnapshot());
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
      // The user copies after dispatch, before restoration.
      return callCount < 5 ? 1 : 2;
    });

    const manager = createManager();
    const result = await manager.inject('hello');

    expect(result).toEqual({
      kind: 'clipboard-conflict',
      reason: 'Clipboard contents changed during dictation',
    });
    expect(mockClipboardIO.restoreSnapshot).not.toHaveBeenCalled();
  });

  it('does not paste a newer clipboard owner copied during staging', async () => {
    let sequence = 1;
    mockClipboardMonitor.getSequenceNumber = mock(() => sequence);
    mockDelay = mock(async () => { sequence += 1; });

    expect((await createManager().inject('hello')).kind).toBe('clipboard-conflict');
    expect(mockInputSimulator.simulatePaste).not.toHaveBeenCalled();
    expect(mockClipboardIO.restoreSnapshot).not.toHaveBeenCalled();
  });

  it('leaves an unsupported clipboard format intact instead of staging over it', async () => {
    mockClipboardIO.captureSnapshot = mock(() => createClipboardSnapshot({ skippedFormats: ['application/private'] }));

    expect(await createManager().inject('hello')).toMatchObject({ kind: 'input-blocked', acceptedEvents: 0 });
    expect(mockClipboardIO.writeText).not.toHaveBeenCalled();
    expect(mockInputSimulator.simulatePaste).not.toHaveBeenCalled();
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

  it('does not claim success or offer a safe replay after clipboard restoration fails', async () => {
    mockClipboardIO.restoreSnapshot = mock(() => { throw new Error('Clipboard is locked'); });
    const result = await createManager().inject('hello');
    expect(mockInputSimulator.simulatePaste).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('clipboard could not be restored safely') });
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
