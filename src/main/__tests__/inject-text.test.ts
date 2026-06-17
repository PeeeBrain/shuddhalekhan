import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { installElectronMock } from '../../test/electron-mock';
import type {
  injectIntoFocusedApp as InjectIntoFocusedApp,
  copyLastTranscriptToClipboard as CopyLastTranscriptToClipboard,
  InjectResult,
} from '../inject-text';
import type { PasteDispatchResult } from '../native/clipboard';
import type { DictationTargetSnapshot, PasteStrategy } from '../../types/ipc';

const vi = { fn: mock };
let injectIntoFocusedApp: typeof InjectIntoFocusedApp;
let copyLastTranscriptToClipboard: typeof CopyLastTranscriptToClipboard;

installElectronMock();
mock.module('../native/clipboard', () => ({ simulatePaste: vi.fn() }));
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

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    readText: overrides.readText ?? vi.fn(() => 'original clipboard'),
    writeText: overrides.writeText ?? vi.fn(),
    simulatePaste: overrides.simulatePaste ?? vi.fn((): PasteDispatchResult => ({ acceptedEvents: 4 })),
    captureTarget: overrides.captureTarget ?? vi.fn(() => defaultTarget),
    resolvePasteStrategy: overrides.resolvePasteStrategy ?? vi.fn(() => 'ctrl-v' as PasteStrategy),
    getPasteStrategyConfig: overrides.getPasteStrategyConfig ?? vi.fn(() => ({ default: 'ctrl-v' as PasteStrategy, overrides: {} })),
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
    expect(deps.readText).toHaveBeenCalledTimes(1);
    expect(deps.writeText).toHaveBeenNthCalledWith(1, 'transcribed text');
    expect(deps.delay).toHaveBeenNthCalledWith(1, 50);
    expect(deps.simulatePaste).toHaveBeenCalledTimes(1);
    expect(deps.delay).toHaveBeenNthCalledWith(2, 100);
    expect(deps.writeText).toHaveBeenNthCalledWith(2, 'original clipboard');
  });

  it('does not restore clipboard when the previous clipboard was empty', async () => {
    deps.readText.mockReturnValue('');

    await injectIntoFocusedApp('text', null, deps);

    expect(deps.writeText).toHaveBeenCalledTimes(1);
    expect(deps.writeText).toHaveBeenCalledWith('text');
  });

  it('returns input-blocked when zero events are accepted', async () => {
    deps.simulatePaste.mockReturnValue({ acceptedEvents: 0, errorCode: 5 });

    const result = await injectIntoFocusedApp('text', null, deps);

    expect(result).toEqual({ kind: 'input-blocked', acceptedEvents: 0, reason: 'No input events accepted (Win32 error 5)' });
  });

  it('returns input-blocked with diagnostics for partial dispatch', async () => {
    deps.simulatePaste.mockReturnValue({ acceptedEvents: 2, errorCode: 87 });

    const result = await injectIntoFocusedApp('text', null, deps);

    expect(result).toEqual({ kind: 'input-blocked', acceptedEvents: 2, reason: 'Partial input dispatch (Win32 error 87)' });
  });

  it('returns input-blocked without an error code when none is reported', async () => {
    deps.simulatePaste.mockReturnValue({ acceptedEvents: 1 });

    const result = await injectIntoFocusedApp('text', null, deps);

    expect(result).toEqual({ kind: 'input-blocked', acceptedEvents: 1, reason: 'Partial input dispatch' });
  });

  it('returns error when reading the clipboard fails', async () => {
    deps.readText.mockImplementation(() => {
      throw new Error('clipboard locked');
    });

    const result = await injectIntoFocusedApp('text', null, deps);

    expect(result.kind).toBe('error');
    expect((result as Extract<InjectResult, { kind: 'error' }>).message).toContain('clipboard locked');
  });

  it('returns error when staging the clipboard fails', async () => {
    deps.writeText.mockImplementation(() => {
      throw new Error('write failed');
    });

    const result = await injectIntoFocusedApp('text', null, deps);

    expect(result.kind).toBe('error');
    expect((result as Extract<InjectResult, { kind: 'error' }>).message).toContain('write failed');
  });

  it('returns error when paste dispatch throws', async () => {
    deps.simulatePaste.mockImplementation(() => {
      throw new Error('SendInput failed');
    });

    const result = await injectIntoFocusedApp('text', null, deps);

    expect(result.kind).toBe('error');
    expect((result as Extract<InjectResult, { kind: 'error' }>).message).toContain('SendInput failed');
  });

  it('serializes concurrent injections so they do not interleave', async () => {
    const writeOrder: string[] = [];
    deps.writeText.mockImplementation((text: string) => {
      writeOrder.push(text);
    });
    deps.simulatePaste.mockImplementation(() => {
      writeOrder.push('paste');
      return { acceptedEvents: 4 };
    });

    const [first, second] = await Promise.all([
      injectIntoFocusedApp('first', null, deps),
      injectIntoFocusedApp('second', null, deps),
    ]);

    expect(first.kind).toBe('input-dispatched');
    expect(second.kind).toBe('input-dispatched');
    expect(writeOrder).toEqual(['first', 'paste', 'original clipboard', 'second', 'paste', 'original clipboard']);
  });

  it('captures the current foreground target before injection', async () => {
    await injectIntoFocusedApp('text', null, deps);

    expect(deps.captureTarget).toHaveBeenCalledTimes(1);
  });

  it('resolves the paste strategy from the current target executable', async () => {
    deps.resolvePasteStrategy.mockReturnValue('shift-insert');

    await injectIntoFocusedApp('text', null, deps);

    expect(deps.resolvePasteStrategy).toHaveBeenCalledWith('C:\\Windows\\notepad.exe', { default: 'ctrl-v', overrides: {} });
    expect(deps.simulatePaste).toHaveBeenCalledWith('shift-insert');
  });

  it('returns target-changed when the foreground target moved to a different process', async () => {
    const startSnapshot: DictationTargetSnapshot = { ...defaultTarget, processId: 100 };
    deps.captureTarget.mockReturnValue({ ...defaultTarget, processId: 200 });

    const result = await injectIntoFocusedApp('text', startSnapshot, deps);

    expect(result).toEqual({ kind: 'target-changed', reason: 'target-changed: focus moved to a different process' });
    expect(deps.simulatePaste).not.toHaveBeenCalled();
  });

  it('returns target-changed when the foreground target is no longer inspectable', async () => {
    deps.captureTarget.mockReturnValue(null);

    const result = await injectIntoFocusedApp('text', defaultTarget, deps);

    expect(result).toEqual({ kind: 'target-changed', reason: 'target-changed: foreground target is missing or invalid' });
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

    expect(result).toEqual({ kind: 'target-changed', reason: 'target-changed: foreground target inspection failed' });
    expect(deps.simulatePaste).not.toHaveBeenCalled();
  });
});
