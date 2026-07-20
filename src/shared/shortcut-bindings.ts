import type { ShortcutBinding, ShortcutModifier, ShortcutsConfig } from '../types/ipc';
import {
  DELETE_KEY_CODE,
  ESCAPE_KEY_CODE,
  isSupportedOrdinaryKey,
  modifierDisplayName,
  ordinaryKeyByCode,
} from './shortcut-keys';

export const SHORTCUT_MODIFIER_ORDER: ShortcutModifier[] = ['ctrl', 'alt', 'shift', 'win'];

export const DEFAULT_SHORTCUTS: ShortcutsConfig = {
  dictation: {
    binding: { keyCode: null, modifiers: ['ctrl', 'win'] },
    activationMode: 'push-to-talk',
  },
  agent: {
    binding: { keyCode: null, modifiers: ['alt', 'win'] },
    activationMode: 'push-to-talk',
  },
};

/** Canonicalize a binding: supported key, deduplicated modifiers in canonical order. */
export function normalizeBinding(binding: ShortcutBinding): ShortcutBinding {
  const modifiers = SHORTCUT_MODIFIER_ORDER.filter((modifier) =>
    binding.modifiers.includes(modifier),
  );
  const keyCode = binding.keyCode !== null && isSupportedOrdinaryKey(binding.keyCode)
    ? binding.keyCode
    : null;
  return { keyCode, modifiers };
}

export function bindingsEqual(
  a: ShortcutBinding | null,
  b: ShortcutBinding | null,
): boolean {
  if (a === null || b === null) return a === b;
  const left = normalizeBinding(a);
  const right = normalizeBinding(b);
  return (
    left.keyCode === right.keyCode
    && left.modifiers.length === right.modifiers.length
    && left.modifiers.every((modifier, index) => modifier === right.modifiers[index])
  );
}

/** Human-readable keycap text such as "Ctrl + Shift + R". */
export function formatBinding(binding: ShortcutBinding | null): string {
  if (!binding) return 'Not assigned';
  const normalized = normalizeBinding(binding);
  const parts = normalized.modifiers.map(modifierDisplayName);
  if (normalized.keyCode !== null) {
    parts.push(ordinaryKeyByCode(normalized.keyCode)?.name ?? 'Unknown');
  }
  return parts.length > 0 ? parts.join(' + ') : 'Not assigned';
}

export type BindingVerdict =
  | { status: 'ok' }
  | { status: 'warning'; message: string }
  | { status: 'error'; message: string };

/**
 * Assess a candidate binding for one intent against the other intent's binding.
 *
 * - error: reserved, unsupported, or internally ambiguous bindings that must
 *   not be saved.
 * - warning: disruptive but capturable bindings that require an explicit
 *   "Use anyway" confirmation.
 */
export function assessBinding(
  candidate: ShortcutBinding | null,
  otherIntentBinding: ShortcutBinding | null,
): BindingVerdict {
  if (candidate === null) return { status: 'ok' };

  const binding = normalizeBinding(candidate);
  if (binding.keyCode === null && binding.modifiers.length === 0) {
    return { status: 'error', message: 'Choose at least one key for the shortcut.' };
  }

  if (binding.keyCode === ESCAPE_KEY_CODE) {
    return {
      status: 'error',
      message: 'Escape is reserved for cancelling shortcut capture and cannot be assigned.',
    };
  }

  if (candidate.keyCode !== null && !isSupportedOrdinaryKey(candidate.keyCode)) {
    return {
      status: 'error',
      message: 'This key cannot be used as a global shortcut.',
    };
  }

  if (
    binding.keyCode === DELETE_KEY_CODE
    && binding.modifiers.includes('ctrl')
    && binding.modifiers.includes('alt')
  ) {
    return {
      status: 'error',
      message: 'Ctrl + Alt + Delete is reserved by Windows and cannot be hooked reliably.',
    };
  }

  if (otherIntentBinding !== null && bindingsEqual(binding, otherIntentBinding)) {
    return {
      status: 'error',
      message: 'Dictation and Agent Mode cannot use the same shortcut.',
    };
  }

  if (binding.keyCode !== null && binding.modifiers.length === 0) {
    return {
      status: 'warning',
      message: `${formatBinding(binding)} will be consumed everywhere while assigned and cannot be typed in other apps.`,
    };
  }

  if (binding.keyCode === null) {
    return {
      status: 'warning',
      message: 'A modifier-only shortcut can interfere with normal keyboard use in other apps.',
    };
  }

  return { status: 'ok' };
}
