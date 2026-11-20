import { describe, expect, it, mock, beforeEach } from 'bun:test';
import {
  ClipboardTransactionManager,
  type ClipboardIO,
  type ForegroundInspector,
  type InputSimulator,
  type ClipboardMonitor,
  type PasteStrategyResolver,
  type ClipboardSnapshot,
  type TransientWrite,
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
      writeTransientText: mock((): TransientWrite => 'staged'),
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
    expect(mockClipboardIO.writeTransientText).toHaveBeenCalledWith('hello', 1);
    expect(mockClipboardIO.writeText).not.toHaveBeenCalled();
    expect(mockDelay).toHaveBeenNthCalledWith(1, 50);
    expect(mockDelay).toHaveBeenNthCalledWith(2, 500);
    expect(mockInputSimulator.simulatePaste).toHaveBeenCalledWith('ctrl-v');
    await manager.flushRestore();
    expect(mockClipboardIO.restoreSnapshot).toHaveBeenCalledTimes(1);
  });

  it('gives Remote Desktop longer to receive the clipboard before and after the paste', async () => {
    const rdp = { ...defaultTarget, executablePath: 'C:\\Windows\\System32\\mstsc.exe' };
    mockForegroundInspector.captureTarget = mock(() => rdp);

    await createManager().inject('hello', { target: rdp });

    expect(mockDelay.mock.calls).toEqual([[400], [3000]]);
  });

  it('returns before restoring, and a later Dictation never gets an older clipboard restored over it', async () => {
    let sequence = 1;
    let clipboard = 'original';
    const writes: string[] = [];
    const write = (text = '') => {
      sequence += 1;
      clipboard = text;
      writes.push(text);
    };
    mockClipboardMonitor.getSequenceNumber = mock(() => sequence);
    mockClipboardIO.captureSnapshot = mock(() => createClipboardSnapshot({ text: clipboard }));
    mockClipboardIO.writeTransientText = mock((text: string): TransientWrite => {
      write(text);
      return 'staged';
    });
    mockClipboardIO.restoreSnapshot = mock((snapshot: ClipboardSnapshot) => write(snapshot.text));
    const restoreTimers: (() => void)[] = [];
    mockDelay = mock((ms: number) => ms === 500 ? new Promise<void>((resolve) => restoreTimers.push(resolve)) : Promise.resolve());
    const manager = createManager();

    expect((await manager.inject('first')).kind).toBe('input-dispatched');
    expect(clipboard).toBe('first');

    expect((await manager.inject('second')).kind).toBe('input-dispatched');
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    restoreTimers[0]();
    await settle();
    // The first restore ran before the second transcript was staged; its late timer restores nothing.
    expect(writes).toEqual(['first', 'original', 'second']);

    restoreTimers[1]();
    await settle();
    expect(writes).toEqual(['first', 'original', 'second', 'original']);
  });

  it('leaves a copy made after the paste in place', async () => {
    let sequence = 1;
    mockClipboardMonitor.getSequenceNumber = mock(() => sequence);
    mockDelay = mock((ms: number) => ms === 500 ? new Promise<void>(() => undefined) : Promise.resolve());
    const manager = createManager();

    expect(await manager.inject('hello')).toEqual({ kind: 'input-dispatched', acceptedEvents: 4 });
    sequence += 1; // the user copies something
    await manager.flushRestore();

    expect(mockClipboardIO.restoreSnapshot).not.toHaveBeenCalled();
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
    expect(mockClipboardIO.writeTransientText).not.toHaveBeenCalled();
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
    expect(mockClipboardIO.writeTransientText).not.toHaveBeenCalled();
    expect(mockClipboardIO.restoreSnapshot).not.toHaveBeenCalled();
  });

  it('restores the original clipboard when staging fails after clearing it', async () => {
    mockClipboardIO.writeTransientText = mock((): TransientWrite => 'cleared');

    const result = await createManager().inject('private transcript');

    expect(result).toEqual({ kind: 'error', message: 'Clipboard transaction failed: the transcript could not be staged' });
    expect(mockInputSimulator.simulatePaste).not.toHaveBeenCalled();
    expect(mockClipboardIO.restoreSnapshot).toHaveBeenCalledWith(createClipboardSnapshot());
  });

  it('leaves a newer copy alone when staging fails without touching the clipboard', async () => {
    let sequence = 1;
    mockClipboardMonitor.getSequenceNumber = mock(() => sequence);
    // Another app copies while it holds the clipboard, so the native write gives up untouched.
    mockClipboardIO.writeTransientText = mock((): TransientWrite => {
      sequence += 1;
      throw new Error('OpenClipboard failed (Win32 error 5)');
    });

    const result = await createManager().inject('private transcript');

    expect(result).toEqual({ kind: 'error', message: 'Clipboard transaction failed: OpenClipboard failed (Win32 error 5)' });
    expect(mockClipboardIO.restoreSnapshot).not.toHaveBeenCalled();
  });

  it('does not stage over a copy made after the snapshot', async () => {
    mockClipboardIO.writeTransientText = mock((): TransientWrite => 'changed');

    expect((await createManager().inject('private transcript')).kind).toBe('clipboard-conflict');
    expect(mockInputSimulator.simulatePaste).not.toHaveBeenCalled();
    expect(mockClipboardIO.restoreSnapshot).not.toHaveBeenCalled();
  });

  it('serializes concurrent inject and stage operations (FIFO queue)', async () => {
    const executionOrder: string[] = [];
    let sequence = 1;
    mockClipboardMonitor.getSequenceNumber = mock(() => sequence);

    mockClipboardIO.writeText = mock((text: string) => {
      sequence += 1;
      executionOrder.push(`write:${text}`);
    });
    mockClipboardIO.writeTransientText = mock((text: string): TransientWrite => {
      sequence += 1;
      executionOrder.push(`transient:${text}`);
      return 'staged';
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
    await manager.flushRestore();

    // The deliberate copy replaced the first transcript, so only the third injection restores.
    expect(executionOrder).toEqual([
      'transient:first',
      'paste',
      'write:second',
      'transient:third',
      'paste',
      'restore',
    ]);
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
    expect(mockClipboardIO.writeTransientText).not.toHaveBeenCalled();
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
    await manager.flushRestore();
    expect(mockClipboardIO.restoreSnapshot).toHaveBeenCalledTimes(1);
  });

  it('reports a restore that fails after the paste went out', async () => {
    mockClipboardIO.restoreSnapshot = mock(() => { throw new Error('Clipboard is locked'); });
    const onRestoreFailed = mock(() => undefined);
    const manager = new ClipboardTransactionManager(
      mockClipboardIO, () => defaultTarget, () => ({ acceptedEvents: 4 }), () => 1, () => 'ctrl-v',
      { delayFn: mockDelay, onRestoreFailed },
    );

    expect((await manager.inject('hello')).kind).toBe('input-dispatched');
    await manager.flushRestore();

    expect(onRestoreFailed).toHaveBeenCalledTimes(1);
  });

  it('does not offer a safe replay when restoring fails before any paste went out', async () => {
    mockClipboardIO.restoreSnapshot = mock(() => { throw new Error('Clipboard is locked'); });
    mockForegroundInspector.captureTarget = mock(() => mockDelay.mock.calls.length ? null : defaultTarget);

    const result = await createManager().inject('hello', { target: defaultTarget });

    expect(mockInputSimulator.simulatePaste).not.toHaveBeenCalled();
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
    await manager.flushRestore();
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
    await manager.flushRestore();
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
