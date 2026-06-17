import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { installElectronMock } from '../../test/electron-mock';
import type {
  injectIntoFocusedApp as InjectIntoFocusedApp,
  copyLastTranscriptToClipboard as CopyLastTranscriptToClipboard,
  InjectResult,
} from '../inject-text';
import type { PasteDispatchResult } from '../native/clipboard';
import type { ClipboardSnapshot } from '../clipboard-transaction';
import type { DictationTargetSnapshot, PasteStrategy } from '../../types/ipc';

const vi = { fn: mock };
let injectIntoFocusedApp: typeof InjectIntoFocusedApp;
let copyLastTranscriptToClipboard: typeof CopyLastTranscriptToClipboard;

installElectronMock();
mock.module('../native/clipboard', () => ({
  simulatePaste: vi.fn(),
  getClipboardSequenceNumber: vi.fn(() => 1),
}));
mock.module('../config', () => ({
  getConfig: () => ({
    pasteStrategy: { default: 'ctrl-v', overrides: {} },
  }),
}));

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

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    readText: overrides.readText ?? vi.fn(() => 'original clipboard'),
    writeText: overrides.writeText ?? vi.fn(),
    simulatePaste: overrides.simulatePaste ?? vi.fn((): PasteDispatchResult => ({ acceptedEvents: 4 })),
    captureTarget: overrides.captureTarget ?? vi.fn(() => defaultTarget),
    resolvePasteStrategy: overrides.resolvePasteStrategy ?? vi.fn(() => 'ctrl-v' as PasteStrategy),
    getPasteStrategyConfig:
      overrides.getPasteStrategyConfig ??
      vi.fn(() => ({ default: 'ctrl-v' as PasteStrategy, overrides: {} })),
    captureClipboardSnapshot:
      overrides.captureClipboardSnapshot ?? vi.fn(() => createClipboardSnapshot()),
    restoreClipboardSnapshot: overrides.restoreClipboardSnapshot ?? vi.fn(),
    getClipboardSequenceNumber: overrides.getClipboardSequenceNumber ?? vi.fn(() => 1),
    delay: overrides.delay ?? vi.fn(async () => undefined),
  };
}

describe('injectIntoFocusedApp', () => {
  let deps: ReturnType<typeof createDeps>;

  beforeEach(async () => {
    ({ injectIntoFocusedApp, copyLastTranscriptToClipboard } = await import(
      `../inject-text?test=${Date.now()}-${Math.random()}`
    ));
    deps = createDeps();
  });

  it('returns input-dispatched with the accepted event count on full dispatch', async () => {
    const result = await injectIntoFocusedApp('transcribed text', null, deps);

    expect(result).toEqual({ kind: 'input-dispatched', acceptedEvents: 4 });
    expect(deps.captureClipboardSnapshot).toHaveBeenCalledTimes(1);
    expect(deps.writeText).toHaveBeenNthCalledWith(1, 'transcribed text');
    expect(deps.getClipboardSequenceNumber).toHaveBeenCalledTimes(2);
    expect(deps.delay).toHaveBeenNthCalledWith(1, 50);
    expect(deps.simulatePaste).toHaveBeenCalledTimes(1);
    expect(deps.delay).toHaveBeenNthCalledWith(2, 100);
    expect(deps.restoreClipboardSnapshot).toHaveBeenCalledTimes(1);
  });

  it('clears an initially empty clipboard after the transaction', async () => {
    deps.captureClipboardSnapshot.mockReturnValue(createClipboardSnapshot({ wasEmpty: true }));

    await injectIntoFocusedApp('text', null, deps);

    expect(deps.restoreClipboardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ wasEmpty: true })
    );
  });

  it('restores plain text clipboard contents after dictation', async () => {
    deps.captureClipboardSnapshot.mockReturnValue(
      createClipboardSnapshot({ wasEmpty: false, text: 'original clipboard' })
    );

    await injectIntoFocusedApp('text', null, deps);

    expect(deps.restoreClipboardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'original clipboard' })
    );
  });

  it('returns input-blocked when zero events are accepted', async () => {
    deps.simulatePaste.mockReturnValue({ acceptedEvents: 0, errorCode: 5 });

    const result = await injectIntoFocusedApp('text', null, deps);

    expect(result).toEqual({
      kind: 'input-blocked',
      acceptedEvents: 0,
      reason: 'No input events accepted (Win32 error 5)',
    });
    expect(deps.restoreClipboardSnapshot).toHaveBeenCalledTimes(1);
  });

  it('returns input-blocked with diagnostics for partial dispatch', async () => {
    deps.simulatePaste.mockReturnValue({ acceptedEvents: 2, errorCode: 87 });

    const result = await injectIntoFocusedApp('text', null, deps);

    expect(result).toEqual({
      kind: 'input-blocked',
      acceptedEvents: 2,
      reason: 'Partial input dispatch (Win32 error 87)',
    });
  });

  it('returns input-blocked without an error code when none is reported', async () => {
    deps.simulatePaste.mockReturnValue({ acceptedEvents: 1 });

    const result = await injectIntoFocusedApp('text', null, deps);

    expect(result).toEqual({ kind: 'input-blocked', acceptedEvents: 1, reason: 'Partial input dispatch' });
  });

  it('returns error when capturing the clipboard snapshot fails', async () => {
    deps.captureClipboardSnapshot.mockImplementation(() => {
      throw new Error('clipboard locked');
    });

    const result = await injectIntoFocusedApp('text', null, deps);

    expect(result.kind).toBe('error');
    expect((result as Extract<InjectResult, { kind: 'error' }>).message).toContain('clipboard locked');
    expect(deps.restoreClipboardSnapshot).not.toHaveBeenCalled();
  });

  it('returns error when staging the clipboard fails', async () => {
    deps.writeText.mockImplementation(() => {
      throw new Error('write failed');
    });

    const result = await injectIntoFocusedApp('text', null, deps);

    expect(result.kind).toBe('error');
    expect((result as Extract<InjectResult, { kind: 'error' }>).message).toContain('write failed');
  });

  it('returns error when paste dispatch throws and still restores the clipboard', async () => {
    deps.simulatePaste.mockImplementation(() => {
      throw new Error('SendInput failed');
    });

    const result = await injectIntoFocusedApp('text', null, deps);

    expect(result.kind).toBe('error');
    expect((result as Extract<InjectResult, { kind: 'error' }>).message).toContain('SendInput failed');
    expect(deps.restoreClipboardSnapshot).toHaveBeenCalledTimes(1);
  });

  it('returns clipboard-conflict when the clipboard changes after staging', async () => {
    let sequence = 10;
    deps.getClipboardSequenceNumber.mockImplementation(() => ++sequence);

    const result = await injectIntoFocusedApp('text', null, deps);

    expect(result).toEqual({
      kind: 'clipboard-conflict',
      reason: 'Clipboard contents changed during dictation',
    });
    expect(deps.restoreClipboardSnapshot).not.toHaveBeenCalled();
  });

  it('treats a sequence number of 0 as valid conflict-detection input', async () => {
    deps.getClipboardSequenceNumber.mockReturnValue(0);

    const result = await injectIntoFocusedApp('text', null, deps);

    expect(result).toEqual({ kind: 'input-dispatched', acceptedEvents: 4 });
    expect(deps.restoreClipboardSnapshot).toHaveBeenCalledTimes(1);
  });

  it('preserves an earlier paste dispatch error over a later clipboard-conflict', async () => {
    let call = 0;
    deps.getClipboardSequenceNumber.mockImplementation(() => ++call);
    deps.simulatePaste.mockImplementation(() => {
      throw new Error('SendInput failed');
    });

    const result = await injectIntoFocusedApp('text', null, deps);

    expect(result.kind).toBe('error');
    expect((result as Extract<InjectResult, { kind: 'error' }>).message).toContain('SendInput failed');
    expect(deps.restoreClipboardSnapshot).not.toHaveBeenCalled();
  });

  it('does not overwrite the clipboard when a conflict is detected', async () => {
    deps.captureClipboardSnapshot.mockReturnValue(
      createClipboardSnapshot({ wasEmpty: false, text: 'user content' })
    );
    let sequence = 10;
    deps.getClipboardSequenceNumber.mockImplementation(() => ++sequence);

    await injectIntoFocusedApp('text', null, deps);

    expect(deps.writeText).toHaveBeenCalledWith('text');
    expect(deps.restoreClipboardSnapshot).not.toHaveBeenCalled();
  });

  it('restores the clipboard at most once', async () => {
    deps.simulatePaste.mockReturnValue({ acceptedEvents: 4 });

    await injectIntoFocusedApp('text', null, deps);

    expect(deps.restoreClipboardSnapshot).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent injections so they do not interleave', async () => {
    const restoreOrder: string[] = [];
    deps.writeText.mockImplementation((text: string) => {
      restoreOrder.push(text);
    });
    deps.simulatePaste.mockImplementation(() => {
      restoreOrder.push('paste');
      return { acceptedEvents: 4 };
    });
    deps.restoreClipboardSnapshot.mockImplementation(() => {
      restoreOrder.push('restore');
    });

    const [first, second] = await Promise.all([
      injectIntoFocusedApp('first', null, deps),
      injectIntoFocusedApp('second', null, deps),
    ]);

    expect(first.kind).toBe('input-dispatched');
    expect(second.kind).toBe('input-dispatched');
    expect(restoreOrder).toEqual(['first', 'paste', 'restore', 'second', 'paste', 'restore']);
  });

  it('captures the current foreground target before injection', async () => {
    await injectIntoFocusedApp('text', null, deps);

    expect(deps.captureTarget).toHaveBeenCalledTimes(1);
  });

  it('resolves the paste strategy from the current target executable', async () => {
    deps.resolvePasteStrategy.mockReturnValue('shift-insert');

    await injectIntoFocusedApp('text', null, deps);

    expect(deps.resolvePasteStrategy).toHaveBeenCalledWith('C:\\Windows\\notepad.exe', {
      default: 'ctrl-v',
      overrides: {},
    });
    expect(deps.simulatePaste).toHaveBeenCalledWith('shift-insert');
  });

  it('returns target-changed when the foreground target moved to a different process', async () => {
    const startSnapshot: DictationTargetSnapshot = { ...defaultTarget, processId: 100 };
    deps.captureTarget.mockReturnValue({ ...defaultTarget, processId: 200 });

    const result = await injectIntoFocusedApp('text', startSnapshot, deps);

    expect(result).toEqual({
      kind: 'target-changed',
      reason: 'target-changed: focus moved to a different process',
    });
    expect(deps.simulatePaste).not.toHaveBeenCalled();
  });

  it('returns target-changed when the foreground target is no longer inspectable', async () => {
    deps.captureTarget.mockReturnValue(null);

    const result = await injectIntoFocusedApp('text', defaultTarget, deps);

    expect(result).toEqual({
      kind: 'target-changed',
      reason: 'target-changed: foreground target is missing or invalid',
    });
    expect(deps.simulatePaste).not.toHaveBeenCalled();
  });

  it('dispatches paste for a different window in the same process and logs the transition', async () => {
    const startSnapshot: DictationTargetSnapshot = { ...defaultTarget, hwnd: 1 };
    deps.captureTarget.mockReturnValue({ ...defaultTarget, hwnd: 2 });

    const result = await injectIntoFocusedApp('text', startSnapshot, deps);

    expect(result).toEqual({ kind: 'input-dispatched', acceptedEvents: 4 });
  });

  it('copies the last transcript to the clipboard without synthetic input', () => {
    copyLastTranscriptToClipboard('saved text', { writeText: deps.writeText });

    expect(deps.writeText).toHaveBeenCalledTimes(1);
    expect(deps.writeText).toHaveBeenCalledWith('saved text');
    expect(deps.simulatePaste).not.toHaveBeenCalled();
  });

  it('returns target-changed when inspecting the current foreground target fails', async () => {
    deps.captureTarget.mockImplementation(() => {
      throw new Error('user32 failed');
    });

    const result = await injectIntoFocusedApp('text', defaultTarget, deps);

    expect(result).toEqual({
      kind: 'target-changed',
      reason: 'target-changed: foreground target inspection failed',
    });
    expect(deps.simulatePaste).not.toHaveBeenCalled();
  });
});
