import type { ShortcutBinding, ShortcutModifier } from '../../types/ipc';
import {
  BACKSPACE_KEY_CODE,
  DELETE_KEY_CODE,
  modifierForDomCode,
  ordinaryKeyByDomCode,
} from '../../shared/shortcut-keys';
import { normalizeBinding } from '../../shared/shortcut-bindings';

export interface ShortcutCaptureState {
  heldCodes: string[];
  modifiers: ShortcutModifier[];
  keyCode: number | null;
  started: boolean;
}

export type ShortcutCaptureResult =
  | { kind: 'state'; state: ShortcutCaptureState }
  | { kind: 'complete'; state: ShortcutCaptureState; binding: ShortcutBinding }
  | { kind: 'cancel'; state: ShortcutCaptureState }
  | { kind: 'clear'; state: ShortcutCaptureState }
  | { kind: 'unsupported'; state: ShortcutCaptureState; message: string };

export const EMPTY_CAPTURE_STATE: ShortcutCaptureState = {
  heldCodes: [],
  modifiers: [],
  keyCode: null,
  started: false,
};

export function captureKeyDown(
  state: ShortcutCaptureState,
  domCode: string,
  repeat = false,
): ShortcutCaptureResult {
  if (domCode === 'Escape') return { kind: 'cancel', state };
  if (repeat || state.heldCodes.includes(domCode)) return { kind: 'state', state };

  const ordinary = ordinaryKeyByDomCode(domCode);
  if (
    !state.started
    && ordinary
    && (ordinary.keyCode === BACKSPACE_KEY_CODE || ordinary.keyCode === DELETE_KEY_CODE)
  ) {
    return { kind: 'clear', state };
  }

  const modifier = modifierForDomCode(domCode);
  if (!modifier && !ordinary) {
    return {
      kind: 'unsupported',
      state,
      message: 'This key is not supported. Use a letter, number, punctuation, function, navigation, or modifier key.',
    };
  }

  if (ordinary && state.keyCode !== null && state.keyCode !== ordinary.keyCode) {
    return {
      kind: 'unsupported',
      state,
      message: 'Use one ordinary key with optional modifiers; sequential shortcuts are not supported.',
    };
  }

  return {
    kind: 'state',
    state: {
      heldCodes: [...state.heldCodes, domCode],
      modifiers: modifier
        ? normalizeBinding({ keyCode: null, modifiers: [...state.modifiers, modifier] }).modifiers
        : state.modifiers,
      keyCode: ordinary?.keyCode ?? state.keyCode,
      started: true,
    },
  };
}

export function captureKeyUp(
  state: ShortcutCaptureState,
  domCode: string,
): ShortcutCaptureResult {
  if (!state.heldCodes.includes(domCode)) return { kind: 'state', state };
  const next = {
    ...state,
    heldCodes: state.heldCodes.filter((code) => code !== domCode),
  };
  if (next.started && next.heldCodes.length === 0) {
    return {
      kind: 'complete',
      state: next,
      binding: normalizeBinding({ keyCode: next.keyCode, modifiers: next.modifiers }),
    };
  }
  return { kind: 'state', state: next };
}
