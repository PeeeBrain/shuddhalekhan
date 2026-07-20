import type { ShortcutModifier } from '../types/ipc';

/**
 * Registry of keys that may participate in a global shortcut binding.
 *
 * Ordinary keys are identified by their Windows virtual-key code (what the
 * low-level hook sees) and mapped to a logical Windows key name for display
 * and a DOM `KeyboardEvent.code` for inline capture in the Settings window.
 * Mouse buttons, media/vendor keys, and browser keys are deliberately absent:
 * they cannot be captured or assigned.
 */

export interface OrdinaryKeyDefinition {
  keyCode: number;
  /** Logical Windows key name shown on keycaps. */
  name: string;
  /** DOM KeyboardEvent.code used during inline capture. */
  domCode: string;
}

const VK_BACK = 0x08;
const VK_TAB = 0x09;
const VK_RETURN = 0x0d;
const VK_ESCAPE = 0x1b;
const VK_SPACE = 0x20;

export const ESCAPE_KEY_CODE = VK_ESCAPE;
export const BACKSPACE_KEY_CODE = VK_BACK;
export const DELETE_KEY_CODE = 0x2e;

const EDITING_AND_WHITESPACE_KEYS: OrdinaryKeyDefinition[] = [
  { keyCode: VK_BACK, name: 'Backspace', domCode: 'Backspace' },
  { keyCode: VK_TAB, name: 'Tab', domCode: 'Tab' },
  { keyCode: VK_RETURN, name: 'Enter', domCode: 'Enter' },
  { keyCode: VK_SPACE, name: 'Space', domCode: 'Space' },
  { keyCode: VK_ESCAPE, name: 'Escape', domCode: 'Escape' },
];

const NAVIGATION_KEYS: OrdinaryKeyDefinition[] = [
  { keyCode: 0x21, name: 'Page Up', domCode: 'PageUp' },
  { keyCode: 0x22, name: 'Page Down', domCode: 'PageDown' },
  { keyCode: 0x23, name: 'End', domCode: 'End' },
  { keyCode: 0x24, name: 'Home', domCode: 'Home' },
  { keyCode: 0x25, name: 'Left', domCode: 'ArrowLeft' },
  { keyCode: 0x26, name: 'Up', domCode: 'ArrowUp' },
  { keyCode: 0x27, name: 'Right', domCode: 'ArrowRight' },
  { keyCode: 0x28, name: 'Down', domCode: 'ArrowDown' },
  { keyCode: 0x2d, name: 'Insert', domCode: 'Insert' },
  { keyCode: DELETE_KEY_CODE, name: 'Delete', domCode: 'Delete' },
];

const LETTER_KEYS: OrdinaryKeyDefinition[] = Array.from({ length: 26 }, (_, i) => ({
  keyCode: 0x41 + i,
  name: String.fromCharCode(65 + i),
  domCode: `Key${String.fromCharCode(65 + i)}`,
}));

const DIGIT_KEYS: OrdinaryKeyDefinition[] = Array.from({ length: 10 }, (_, i) => ({
  keyCode: 0x30 + i,
  name: String(i),
  domCode: `Digit${i}`,
}));

const FUNCTION_KEYS: OrdinaryKeyDefinition[] = Array.from({ length: 24 }, (_, i) => ({
  keyCode: 0x70 + i,
  name: `F${i + 1}`,
  domCode: `F${i + 1}`,
}));

const PUNCTUATION_KEYS: OrdinaryKeyDefinition[] = [
  { keyCode: 0xba, name: ';', domCode: 'Semicolon' },
  { keyCode: 0xbb, name: '=', domCode: 'Equal' },
  { keyCode: 0xbc, name: ',', domCode: 'Comma' },
  { keyCode: 0xbd, name: '-', domCode: 'Minus' },
  { keyCode: 0xbe, name: '.', domCode: 'Period' },
  { keyCode: 0xbf, name: '/', domCode: 'Slash' },
  { keyCode: 0xc0, name: '`', domCode: 'Backquote' },
  { keyCode: 0xdb, name: '[', domCode: 'BracketLeft' },
  { keyCode: 0xdc, name: '\\', domCode: 'Backslash' },
  { keyCode: 0xdd, name: ']', domCode: 'BracketRight' },
  { keyCode: 0xde, name: "'", domCode: 'Quote' },
  { keyCode: 0xe2, name: '<', domCode: 'IntlBackslash' },
];

export const ORDINARY_KEYS: OrdinaryKeyDefinition[] = [
  ...EDITING_AND_WHITESPACE_KEYS,
  ...NAVIGATION_KEYS,
  ...LETTER_KEYS,
  ...DIGIT_KEYS,
  ...FUNCTION_KEYS,
  ...PUNCTUATION_KEYS,
];

const BY_KEY_CODE = new Map(ORDINARY_KEYS.map((key) => [key.keyCode, key]));
const BY_DOM_CODE = new Map(ORDINARY_KEYS.map((key) => [key.domCode, key]));

export function ordinaryKeyByCode(keyCode: number): OrdinaryKeyDefinition | undefined {
  return BY_KEY_CODE.get(keyCode);
}

export function ordinaryKeyByDomCode(domCode: string): OrdinaryKeyDefinition | undefined {
  return BY_DOM_CODE.get(domCode);
}

export function isSupportedOrdinaryKey(keyCode: number): boolean {
  return BY_KEY_CODE.has(keyCode);
}

export interface ModifierDefinition {
  /** Logical modifier identity shared by left and right variants. */
  id: ShortcutModifier;
  /** Logical Windows key name shown on keycaps. */
  name: string;
  keyCodes: number[];
  domCodes: string[];
}

export const MODIFIER_DEFINITIONS: ModifierDefinition[] = [
  { id: 'ctrl', name: 'Ctrl', keyCodes: [0xa2, 0xa3], domCodes: ['ControlLeft', 'ControlRight'] },
  { id: 'alt', name: 'Alt', keyCodes: [0xa4, 0xa5], domCodes: ['AltLeft', 'AltRight'] },
  { id: 'shift', name: 'Shift', keyCodes: [0xa0, 0xa1], domCodes: ['ShiftLeft', 'ShiftRight'] },
  { id: 'win', name: 'Win', keyCodes: [0x5b, 0x5c], domCodes: ['MetaLeft', 'MetaRight'] },
];

const MODIFIER_BY_KEY_CODE = new Map<number, ShortcutModifier>();
const MODIFIER_BY_DOM_CODE = new Map<string, ShortcutModifier>();
for (const definition of MODIFIER_DEFINITIONS) {
  for (const keyCode of definition.keyCodes) MODIFIER_BY_KEY_CODE.set(keyCode, definition.id);
  for (const domCode of definition.domCodes) MODIFIER_BY_DOM_CODE.set(domCode, definition.id);
}

/** Normalize a left/right virtual-key code to its logical modifier identity. */
export function modifierForKeyCode(keyCode: number): ShortcutModifier | null {
  return MODIFIER_BY_KEY_CODE.get(keyCode) ?? null;
}

/** Normalize a DOM KeyboardEvent.code to its logical modifier identity. */
export function modifierForDomCode(domCode: string): ShortcutModifier | null {
  return MODIFIER_BY_DOM_CODE.get(domCode) ?? null;
}

export function modifierDisplayName(modifier: ShortcutModifier): string {
  const definition = MODIFIER_DEFINITIONS.find((item) => item.id === modifier);
  return definition?.name ?? modifier;
}
