import { describe, expect, it } from 'bun:test';
import {
  resolvePasteStrategy,
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

  it('pastes into Linux terminals with Ctrl+Shift+V unless the user overrode them', () => {
    const config: PasteStrategyConfig = { default: 'ctrl-v', overrides: { kitty: 'shift-insert' } };

    expect(resolvePasteStrategy('org.kde.konsole', config)).toBe('ctrl-shift-v');
    expect(resolvePasteStrategy('/usr/libexec/gnome-terminal-server', config)).toBe('ctrl-shift-v');
    expect(resolvePasteStrategy('kitty', config)).toBe('shift-insert');
    expect(resolvePasteStrategy('org.kde.kate', config)).toBe('ctrl-v');
  });

});
