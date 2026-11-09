import type { PasteStrategy, PasteStrategyConfig } from '../types/ipc';
import { PASTE_CHORDS } from '../shared/shortcut-bindings';

const MODIFIER_KEYS = { ctrl: 0x11, shift: 0x10 };
export const PASTE_KEYSYMS = new Map([[0x11, 0xffe3], [0x10, 0xffe1], [0x56, 0x76], [0x2d, 0xff63]]);

export interface PasteDispatchResult {
  acceptedEvents: number;
  errorCode?: number;
  error?: string;
}

export interface KeyEvent {
  vk: number;
  up: boolean;
}

export function buildPasteStrategyEvents(strategy: PasteStrategy): KeyEvent[] {
  const chord = PASTE_CHORDS[strategy];
  const keys = [...chord.modifiers.map(modifier => MODIFIER_KEYS[modifier]), chord.keyCode];
  return [...keys.map(vk => ({ vk, up: false })), ...keys.reverse().map(vk => ({ vk, up: true }))];
}

/**
 * Linux terminals where Ctrl+V reaches the shell as ^V instead of pasting.
 * Names are X11 executables and KDE window app IDs, lowercased.
 */
const CTRL_SHIFT_V_TERMINALS = new Set([
  'konsole', 'org.kde.konsole', 'yakuake', 'org.kde.yakuake',
  'gnome-terminal-server', 'org.gnome.terminal', 'ptyxis', 'org.gnome.ptyxis', 'kgx', 'org.gnome.console',
  'kitty', 'alacritty', 'foot', 'wezterm-gui', 'org.wezfurlong.wezterm', 'ghostty', 'com.mitchellh.ghostty',
  'tilix', 'com.gexperts.tilix', 'xfce4-terminal',
]);

/** `executablePath` is an executable path (Windows/X11) or a KDE window app ID. User overrides always win. */
export function resolvePasteStrategy(
  executablePath: string | null,
  config: PasteStrategyConfig
): PasteStrategy {
  if (!executablePath) return config.default;
  const executableName = executablePath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return config.overrides[executableName]
    ?? (CTRL_SHIFT_V_TERMINALS.has(executableName) ? 'ctrl-shift-v' : config.default);
}
