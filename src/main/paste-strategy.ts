import type { PasteStrategy, PasteStrategyConfig } from '../types/ipc';

export const PASTE_STRATEGIES: PasteStrategy[] = ['ctrl-v', 'shift-insert', 'ctrl-shift-v'];

const KEYEVENTF_KEYUP = 0x0002;

// Virtual-key codes used by paste strategies
const VK_CONTROL = 0x11;
const VK_SHIFT = 0x10;
const VK_V = 0x56;
const VK_INSERT = 0x2d;

export interface KeyEvent {
  vk: number;
  flags: number;
}

export function buildPasteStrategyEvents(strategy: PasteStrategy): KeyEvent[] {
  switch (strategy) {
    case 'ctrl-v':
      return [
        { vk: VK_CONTROL, flags: 0 },
        { vk: VK_V, flags: 0 },
        { vk: VK_V, flags: KEYEVENTF_KEYUP },
        { vk: VK_CONTROL, flags: KEYEVENTF_KEYUP },
      ];
    case 'shift-insert':
      return [
        { vk: VK_SHIFT, flags: 0 },
        { vk: VK_INSERT, flags: 0 },
        { vk: VK_INSERT, flags: KEYEVENTF_KEYUP },
        { vk: VK_SHIFT, flags: KEYEVENTF_KEYUP },
      ];
    case 'ctrl-shift-v':
      return [
        { vk: VK_CONTROL, flags: 0 },
        { vk: VK_SHIFT, flags: 0 },
        { vk: VK_V, flags: 0 },
        { vk: VK_V, flags: KEYEVENTF_KEYUP },
        { vk: VK_SHIFT, flags: KEYEVENTF_KEYUP },
        { vk: VK_CONTROL, flags: KEYEVENTF_KEYUP },
      ];
  }
}

export function resolvePasteStrategy(
  executablePath: string | null,
  config: PasteStrategyConfig
): PasteStrategy {
  if (!executablePath) return config.default;
  const executableName = executablePath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return config.overrides[executableName] ?? config.default;
}

export function isValidPasteStrategy(value: unknown): value is PasteStrategy {
  return PASTE_STRATEGIES.includes(value as PasteStrategy);
}
