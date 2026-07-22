import { describe, expect, it } from 'bun:test';
import {
  captureKeyDown,
  captureKeyUp,
  EMPTY_CAPTURE_STATE,
  type ShortcutCaptureState,
} from '../shortcut-capture';

function stateOf(result: ReturnType<typeof captureKeyDown>): ShortcutCaptureState {
  return result.state;
}

describe('inline shortcut capture', () => {
  it('captures one ordinary key with normalized left/right modifiers on release', () => {
    let state = stateOf(captureKeyDown(EMPTY_CAPTURE_STATE, 'ControlRight'));
    state = stateOf(captureKeyDown(state, 'ShiftLeft'));
    state = stateOf(captureKeyDown(state, 'KeyR'));
    state = captureKeyUp(state, 'KeyR').state;
    state = captureKeyUp(state, 'ControlRight').state;
    const result = captureKeyUp(state, 'ShiftLeft');

    expect(result).toMatchObject({
      kind: 'complete',
      binding: { keyCode: 0x52, modifiers: ['ctrl', 'shift'] },
    });
  });

  it('captures modifier-only combinations', () => {
    let state = stateOf(captureKeyDown(EMPTY_CAPTURE_STATE, 'AltLeft'));
    state = stateOf(captureKeyDown(state, 'MetaRight'));
    state = captureKeyUp(state, 'AltLeft').state;
    const result = captureKeyUp(state, 'MetaRight');

    expect(result).toMatchObject({
      kind: 'complete',
      binding: { keyCode: null, modifiers: ['alt', 'win'] },
    });
  });

  it('normalizes both sides of one modifier to a shared logical identity', () => {
    let state = stateOf(captureKeyDown(EMPTY_CAPTURE_STATE, 'ControlLeft'));
    state = stateOf(captureKeyDown(state, 'ControlRight'));
    state = captureKeyUp(state, 'ControlLeft').state;
    const result = captureKeyUp(state, 'ControlRight');

    expect(result).toMatchObject({ kind: 'complete', binding: { keyCode: null, modifiers: ['ctrl'] } });
  });

  it('uses Escape exclusively to cancel capture', () => {
    expect(captureKeyDown(EMPTY_CAPTURE_STATE, 'Escape').kind).toBe('cancel');
  });

  it('clears an assigned binding with idle Backspace or Delete', () => {
    expect(captureKeyDown(EMPTY_CAPTURE_STATE, 'Backspace').kind).toBe('clear');
    expect(captureKeyDown(EMPTY_CAPTURE_STATE, 'Delete').kind).toBe('clear');
  });

  it('captures Backspace and Delete after recording begins', () => {
    let backspace = stateOf(captureKeyDown(EMPTY_CAPTURE_STATE, 'ControlLeft'));
    backspace = stateOf(captureKeyDown(backspace, 'Backspace'));
    backspace = captureKeyUp(backspace, 'ControlLeft').state;
    expect(captureKeyUp(backspace, 'Backspace')).toMatchObject({
      kind: 'complete',
      binding: { keyCode: 0x08, modifiers: ['ctrl'] },
    });

    let deletion = stateOf(captureKeyDown(EMPTY_CAPTURE_STATE, 'ShiftLeft'));
    deletion = stateOf(captureKeyDown(deletion, 'Delete'));
    deletion = captureKeyUp(deletion, 'Delete').state;
    expect(captureKeyUp(deletion, 'ShiftLeft')).toMatchObject({
      kind: 'complete',
      binding: { keyCode: 0x2e, modifiers: ['shift'] },
    });
  });

  it('ignores repeat keydowns', () => {
    const state = stateOf(captureKeyDown(EMPTY_CAPTURE_STATE, 'KeyR'));
    expect(captureKeyDown(state, 'KeyR', true)).toEqual({ kind: 'state', state });
  });

  it('rejects media/vendor keys and multiple ordinary keys', () => {
    expect(captureKeyDown(EMPTY_CAPTURE_STATE, 'MediaPlayPause').kind).toBe('unsupported');

    const state = stateOf(captureKeyDown(EMPTY_CAPTURE_STATE, 'KeyR'));
    expect(captureKeyDown(state, 'KeyT').kind).toBe('unsupported');
  });
});
