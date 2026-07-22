import { describe, expect, it } from 'bun:test';
import {
  buildPasteStrategyEvents,
  resolvePasteStrategy,
  isValidPasteStrategy,
} from '../paste-strategy';
import type { PasteStrategyConfig } from '../../types/ipc';

describe('paste strategy resolver', () => {
  it('defaults to ctrl-v when no executable path is provided', () => {
    const config: PasteStrategyConfig = { default: 'ctrl-v', overrides: { 'cmd.exe': 'ctrl-shift-v' } };

    expect(resolvePasteStrategy(null, config)).toBe('ctrl-v');
  });

  it('uses the configured default when no override matches', () => {
    const config: PasteStrategyConfig = { default: 'shift-insert', overrides: {} };

    expect(resolvePasteStrategy('C:\\Windows\\notepad.exe', config)).toBe('shift-insert');
  });

  it('uses an override keyed by executable file name', () => {
    const config: PasteStrategyConfig = {
      default: 'ctrl-v',
      overrides: { 'windowsterminal.exe': 'ctrl-shift-v' },
    };

    expect(resolvePasteStrategy('C:\\Program Files\\WindowsTerminal\\WindowsTerminal.exe', config)).toBe(
      'ctrl-shift-v'
    );
  });

  it('matches overrides case-insensitively', () => {
    const config: PasteStrategyConfig = { default: 'ctrl-v', overrides: { 'notepad.exe': 'shift-insert' } };

    expect(resolvePasteStrategy('C:\\Windows\\NOTEPAD.EXE', config)).toBe('shift-insert');
  });

  it('validates known paste strategies', () => {
    expect(isValidPasteStrategy('ctrl-v')).toBe(true);
    expect(isValidPasteStrategy('shift-insert')).toBe(true);
    expect(isValidPasteStrategy('ctrl-shift-v')).toBe(true);
    expect(isValidPasteStrategy('unknown')).toBe(false);
  });
});

describe('paste strategy input builder', () => {
  it('generates ctrl-v key events in down/up order', () => {
    const events = buildPasteStrategyEvents('ctrl-v');

    expect(events.map((e) => ({ vk: e.vk, up: e.flags !== 0 }))).toEqual([
      { vk: 0x11, up: false },
      { vk: 0x56, up: false },
      { vk: 0x56, up: true },
      { vk: 0x11, up: true },
    ]);
  });

  it('generates shift-insert key events in down/up order', () => {
    const events = buildPasteStrategyEvents('shift-insert');

    expect(events.map((e) => ({ vk: e.vk, up: e.flags !== 0 }))).toEqual([
      { vk: 0x10, up: false },
      { vk: 0x2d, up: false },
      { vk: 0x2d, up: true },
      { vk: 0x10, up: true },
    ]);
  });

  it('generates ctrl-shift-v key events in correct nested order', () => {
    const events = buildPasteStrategyEvents('ctrl-shift-v');

    expect(events.map((e) => ({ vk: e.vk, up: e.flags !== 0 }))).toEqual([
      { vk: 0x11, up: false },
      { vk: 0x10, up: false },
      { vk: 0x56, up: false },
      { vk: 0x56, up: true },
      { vk: 0x10, up: true },
      { vk: 0x11, up: true },
    ]);
  });
});
