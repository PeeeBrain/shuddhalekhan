import { describe, expect, it } from 'bun:test';
import {
  assessBinding,
  bindingsEqual,
  DEFAULT_SHORTCUTS,
  formatBinding,
  normalizeBinding,
} from '../shortcut-bindings';
import { ordinaryKeyByDomCode } from '../shortcut-keys';

describe('normalizeBinding', () => {
  it('orders modifiers canonically and removes duplicates', () => {
    expect(normalizeBinding({ keyCode: 0x52, modifiers: ['win', 'ctrl', 'ctrl'] })).toEqual({
      keyCode: 0x52,
      modifiers: ['ctrl', 'win'],
    });
  });

  it('drops the ordinary key when it is not supported', () => {
    expect(normalizeBinding({ keyCode: 0xff, modifiers: ['ctrl'] })).toEqual({
      keyCode: null,
      modifiers: ['ctrl'],
    });
  });
});

describe('bindingsEqual', () => {
  it('treats modifier order as insignificant', () => {
    expect(
      bindingsEqual(
        { keyCode: 0x52, modifiers: ['ctrl', 'shift'] },
        { keyCode: 0x52, modifiers: ['shift', 'ctrl'] },
      ),
    ).toBe(true);
  });

  it('distinguishes different keys and modifier sets', () => {
    expect(
      bindingsEqual({ keyCode: 0x52, modifiers: ['ctrl'] }, { keyCode: 0x53, modifiers: ['ctrl'] }),
    ).toBe(false);
    expect(
      bindingsEqual({ keyCode: null, modifiers: ['ctrl'] }, { keyCode: null, modifiers: ['ctrl', 'win'] }),
    ).toBe(false);
  });

  it('treats two unassigned bindings as equal only when both are null', () => {
    expect(bindingsEqual(null, null)).toBe(true);
    expect(bindingsEqual(null, { keyCode: null, modifiers: ['ctrl'] })).toBe(false);
  });
});

describe('formatBinding', () => {
  it('formats modifier chords with logical Windows key names', () => {
    expect(formatBinding({ keyCode: 0x52, modifiers: ['ctrl', 'shift'] })).toBe('Ctrl + Shift + R');
  });

  it('formats modifier-only bindings', () => {
    expect(formatBinding({ keyCode: null, modifiers: ['ctrl', 'win'] })).toBe('Ctrl + Win');
  });

  it('formats navigation and punctuation keys', () => {
    expect(formatBinding({ keyCode: 0x26, modifiers: [] })).toBe('Up');
    expect(formatBinding({ keyCode: 0xba, modifiers: ['alt'] })).toBe('Alt + ;');
  });

  it('labels unassigned bindings', () => {
    expect(formatBinding(null)).toBe('Not assigned');
  });
});

describe('assessBinding', () => {
  const other = { keyCode: 0x51, modifiers: ['ctrl' as const] };

  it('accepts an unassigned binding', () => {
    expect(assessBinding(null, other)).toEqual({ status: 'ok' });
  });

  it('accepts an ordinary key with modifiers', () => {
    expect(assessBinding({ keyCode: 0x52, modifiers: ['ctrl'] }, other)).toEqual({ status: 'ok' });
  });

  it('rejects an identical binding for the other intent as ambiguous', () => {
    const verdict = assessBinding({ keyCode: 0x51, modifiers: ['ctrl'] }, other);
    expect(verdict.status).toBe('error');
    expect(verdict).toMatchObject({ status: 'error' });
  });

  it('does not reject when both intents are unassigned', () => {
    expect(assessBinding(null, null)).toEqual({ status: 'ok' });
  });

  it('rejects Escape as reserved for cancelling capture', () => {
    const verdict = assessBinding({ keyCode: 0x1b, modifiers: [] }, other);
    expect(verdict.status).toBe('error');
  });

  it('rejects Ctrl+Alt+Delete as a Windows-secure sequence', () => {
    const verdict = assessBinding({ keyCode: 0x2e, modifiers: ['ctrl', 'alt'] }, other);
    expect(verdict.status).toBe('error');
  });

  it('rejects unsupported keys such as media or vendor keys', () => {
    const verdict = assessBinding({ keyCode: 0xb3, modifiers: ['ctrl'] }, other);
    expect(verdict.status).toBe('error');
  });

  it('warns that a bare ordinary key is consumed everywhere', () => {
    const verdict = assessBinding({ keyCode: 0x52, modifiers: [] }, other);
    expect(verdict.status).toBe('warning');
  });

  it('warns for bare critical editing keys', () => {
    expect(assessBinding({ keyCode: 0x09, modifiers: [] }, other).status).toBe('warning');
    expect(assessBinding({ keyCode: 0x20, modifiers: [] }, other).status).toBe('warning');
  });

  it('warns that modifier-only bindings interfere with normal typing', () => {
    const verdict = assessBinding({ keyCode: null, modifiers: ['ctrl', 'shift'] }, other);
    expect(verdict.status).toBe('warning');
  });

  it('rejects a binding with neither key nor modifiers', () => {
    const verdict = assessBinding({ keyCode: null, modifiers: [] }, other);
    expect(verdict.status).toBe('error');
  });
});

describe('DEFAULT_SHORTCUTS', () => {
  it('keeps the existing Ctrl+Win and Alt+Win chords as explicit defaults', () => {
    expect(DEFAULT_SHORTCUTS.dictation.binding).toEqual({ keyCode: null, modifiers: ['ctrl', 'win'] });
    expect(DEFAULT_SHORTCUTS.agent.binding).toEqual({ keyCode: null, modifiers: ['alt', 'win'] });
    expect(DEFAULT_SHORTCUTS.dictation.activationMode).toBe('push-to-talk');
    expect(DEFAULT_SHORTCUTS.agent.activationMode).toBe('push-to-talk');
  });
});

describe('key registry', () => {
  it('maps DOM codes for capture to virtual-key codes', () => {
    expect(ordinaryKeyByDomCode('KeyR')?.keyCode).toBe(0x52);
    expect(ordinaryKeyByDomCode('F5')?.keyCode).toBe(0x74);
    expect(ordinaryKeyByDomCode('ArrowUp')?.keyCode).toBe(0x26);
    expect(ordinaryKeyByDomCode('Semicolon')?.keyCode).toBe(0xba);
  });
});
