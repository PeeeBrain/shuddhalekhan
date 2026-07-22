import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { installElectronMock } from '../../test/electron-mock';
import type { validatePasteTarget as ValidatePasteTarget } from '../inject-text';
import type { DictationTargetSnapshot } from '../../types/ipc';

installElectronMock();
mock.module('../native/clipboard', () => ({
  simulatePaste: mock(() => undefined),
  getClipboardSequenceNumber: mock(() => 1),
}));
mock.module('../config', () => ({
  getConfig: () => ({
    pasteStrategy: { default: 'ctrl-v', overrides: {} },
  }),
}));

let validatePasteTarget: typeof ValidatePasteTarget;

beforeEach(async () => {
  ({ validatePasteTarget } = await import(`../inject-text?test=${Date.now()}-${Math.random()}`));
});

function snapshot(partial: Partial<DictationTargetSnapshot>): DictationTargetSnapshot {
  return {
    hwnd: 1,
    processId: 100,
    threadId: 200,
    windowClass: 'TestWindow',
    executablePath: 'C:\\test\\app.exe',
    capturedAt: new Date().toISOString(),
    ...partial,
  };
}

describe('validatePasteTarget', () => {
  it('allows paste when the current target is the same window and process', () => {
    const start = snapshot({ hwnd: 1, processId: 100 });
    const current = snapshot({ hwnd: 1, processId: 100 });

    expect(validatePasteTarget(start, current)).toEqual({ allowed: true, transition: false });
  });

  it('allows paste and records transition for a different window in the same process', () => {
    const start = snapshot({ hwnd: 1, processId: 100 });
    const current = snapshot({ hwnd: 2, processId: 100 });

    expect(validatePasteTarget(start, current)).toEqual({ allowed: true, transition: true });
  });

  it('blocks paste when the current process differs from the start process', () => {
    const start = snapshot({ processId: 100 });
    const current = snapshot({ processId: 200 });

    const result = validatePasteTarget(start, current);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('target-changed');
  });

  it('blocks paste when the current foreground target cannot be inspected', () => {
    const start = snapshot({ processId: 100 });

    const result = validatePasteTarget(start, null);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('target');
  });

  it('allows manual paste when no start snapshot exists but the current target is valid', () => {
    const current = snapshot({ processId: 100 });

    expect(validatePasteTarget(null, current)).toEqual({ allowed: true, transition: false });
  });

  it('blocks paste when no start snapshot and no current target exist', () => {
    const result = validatePasteTarget(null, null);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('target');
  });
});
