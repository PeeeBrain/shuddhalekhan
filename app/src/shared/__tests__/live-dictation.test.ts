import { describe, expect, it } from 'bun:test';
import {
  LIVE_UNICODE_DISPATCH_CODE_UNIT_LIMIT,
  LIVE_KEYBOARD_RELEASE_GRACE_MS,
  computeCommittedDelta,
  countUtf16CodeUnits,
  exceedsUnicodeDispatchLimit,
  hasMalformedControlCharacters,
  interpretUnicodeDispatch,
  projectCommittedText,
  validateExactTarget,
} from '../live-dictation';
import type { DictationTargetSnapshot } from '../../types/ipc';

function target(partial: Partial<DictationTargetSnapshot>): DictationTargetSnapshot {
  return {
    hwnd: 1,
    processId: 100,
    processCreationTime: '2026-01-01T00:00:00.000Z',
    threadId: 200,
    windowClass: 'Notepad',
    executablePath: 'C:\\Windows\\notepad.exe',
    capturedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('committed text projection', () => {
  it('suppresses leading whitespace before the first dispatch', () => {
    expect(projectCommittedText('  hello', 0)).toBe('hello');
    expect(computeCommittedDelta('  hello', 0)).toBe('hello');
  });

  it('does not strip leading whitespace after text has already been dispatched', () => {
    expect(projectCommittedText('hello there', 5)).toBe('hello there');
  });

  it('holds terminal trailing whitespace while streaming', () => {
    expect(projectCommittedText('hello ', 0)).toBe('hello');
    expect(computeCommittedDelta('hello ', 0)).toBe('hello');
  });

  it('releases trailing whitespace during finalization', () => {
    expect(projectCommittedText('hello ', 0, { finalizing: true })).toBe('hello ');
    expect(computeCommittedDelta('hello ', 0, { finalizing: true })).toBe('hello ');
  });

  it('keeps internal whitespace without collapsing it', () => {
    expect(projectCommittedText('hello   world', 0)).toBe('hello   world');
    expect(computeCommittedDelta('hello   world', 5)).toBe('   world');
  });

  it('returns only the newly projected suffix after the external cursor', () => {
    expect(computeCommittedDelta('hello world', 5)).toBe(' world');
    expect(computeCommittedDelta('hello world', 11)).toBe('');
  });
});

describe('malformed committed text', () => {
  it('rejects tabs, CR, LF, NUL, and other ASCII control characters', () => {
    expect(hasMalformedControlCharacters('hello\tworld')).toBe(true);
    expect(hasMalformedControlCharacters('hello\nworld')).toBe(true);
    expect(hasMalformedControlCharacters('hello\rworld')).toBe(true);
    expect(hasMalformedControlCharacters('hello\u0000world')).toBe(true);
    expect(hasMalformedControlCharacters('hello\x7fworld')).toBe(true);
  });

  it('accepts ordinary Unicode spacing, combining marks, surrogate pairs, and ZWJ sequences', () => {
    expect(hasMalformedControlCharacters('hello world')).toBe(false);
    expect(hasMalformedControlCharacters('Cafe\u0301')).toBe(false);
    expect(hasMalformedControlCharacters('🙂')).toBe(false);
    expect(hasMalformedControlCharacters('👨‍👩‍👧‍👦')).toBe(false);
    expect(hasMalformedControlCharacters('नमस्ते')).toBe(false);
  });
});

describe('Unicode dispatch limits', () => {
  it('uses the 4096 UTF-16 code unit single-call limit', () => {
    expect(LIVE_UNICODE_DISPATCH_CODE_UNIT_LIMIT).toBe(4096);
    expect(countUtf16CodeUnits('ab')).toBe(2);
    expect(countUtf16CodeUnits('🙂')).toBe(2);
    expect(exceedsUnicodeDispatchLimit('a'.repeat(4096))).toBe(false);
    expect(exceedsUnicodeDispatchLimit('a'.repeat(4097))).toBe(true);
  });
});

describe('SendInput acceptance classification', () => {
  it('treats zero accepted events as retry-safe without advancing the cursor', () => {
    expect(interpretUnicodeDispatch(0, 8)).toEqual({
      certainty: 'none-accepted',
      recovery: 'retry-safe',
      advanceCursor: false,
    });
  });

  it('treats full acceptance as os-accepted and advances the entire delta', () => {
    expect(interpretUnicodeDispatch(8, 8)).toEqual({
      certainty: 'os-accepted-all',
      recovery: 'copy-only',
      advanceCursor: true,
    });
  });

  it('treats partial acceptance as uncertain and halts without advancing', () => {
    expect(interpretUnicodeDispatch(3, 8, 5)).toEqual({
      certainty: 'ambiguous-partial',
      recovery: 'halt',
      advanceCursor: false,
    });
  });
});

describe('exact original target validation', () => {
  it('accepts the exact original HWND, process, and creation time', () => {
    const original = target({ hwnd: 42, processId: 7, processCreationTime: '2026-01-01T00:00:00.000Z' });
    const current = target({ hwnd: 42, processId: 7, processCreationTime: '2026-01-01T00:00:00.000Z' });
    expect(validateExactTarget(original, current)).toEqual({ allowed: true });
  });

  it('rejects a different HWND even in the same process', () => {
    const original = target({ hwnd: 1, processId: 100 });
    const current = target({ hwnd: 2, processId: 100 });
    expect(validateExactTarget(original, current)).toEqual({
      allowed: false,
      reason: 'target-changed: foreground window is not the original target',
    });
  });

  it('rejects a different process or reused process identity', () => {
    const original = target({ processId: 100, processCreationTime: '2026-01-01T00:00:00.000Z' });
    expect(validateExactTarget(original, target({ processId: 200 }))).toEqual({
      allowed: false,
      reason: 'target-changed: focus moved to a different process',
    });
    expect(validateExactTarget(original, target({
      processId: 100,
      processCreationTime: '2026-01-02T00:00:00.000Z',
    }))).toEqual({
      allowed: false,
      reason: 'target-changed: original process identity is no longer valid',
    });
  });

  it('rejects missing foreground targets and known executable mismatches', () => {
    const original = target({ executablePath: 'C:\\Windows\\notepad.exe' });
    expect(validateExactTarget(original, null)).toEqual({
      allowed: false,
      reason: 'target-changed: foreground target is missing or invalid',
    });
    expect(validateExactTarget(original, target({
      executablePath: 'C:\\Windows\\System32\\cmd.exe',
    }))).toEqual({
      allowed: false,
      reason: 'target-changed: executable path no longer matches the original target',
    });
    expect(validateExactTarget(original, target({ executablePath: null }))).toEqual({ allowed: true });
  });
});

describe('keyboard release grace default', () => {
  it('uses a one-second final keyboard-release grace', () => {
    expect(LIVE_KEYBOARD_RELEASE_GRACE_MS).toBe(1000);
  });
});
