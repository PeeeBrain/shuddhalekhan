import { describe, expect, it, mock } from 'bun:test';
import type { DictationTargetSnapshot } from '../../types/ipc';
import { LiveDictationController } from '../live-dictation-controller';
import type { UnicodeDispatchResult } from '../native/unicode-input';

function target(partial: Partial<DictationTargetSnapshot> = {}): DictationTargetSnapshot {
  return {
    hwnd: 42,
    processId: 7,
    processCreationTime: '2026-01-01T00:00:00.000Z',
    threadId: 8,
    windowClass: 'Notepad',
    executablePath: 'C:\\Windows\\notepad.exe',
    capturedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function successDispatch(text: string): UnicodeDispatchResult {
  const expectedEvents = text.length * 2;
  return {
    acceptedEvents: expectedEvents,
    expectedEvents,
    certainty: 'os-accepted-all',
    recovery: 'copy-only',
    advanceCursor: true,
  };
}

describe('LiveDictationController', () => {
  it('dispatches a committed suffix after the keyboard is clear', async () => {
    const dispatchUnicode = mock((text: string) => successDispatch(text));
    const controller = new LiveDictationController({
      originalTarget: target(),
      captureTarget: () => target(),
      isKeyboardClear: () => true,
      dispatchUnicode,
    });

    await controller.onCommittedUpdate('hello');
    expect(dispatchUnicode).toHaveBeenCalledWith('hello');
    expect(controller.getState().dispatchedProjectedLength).toBe(5);
  });

  it('coalesces prefix extensions while keys are held and dispatches once on release', async () => {
    const dispatchUnicode = mock((text: string) => successDispatch(text));
    let keyboardClear = false;
    const controller = new LiveDictationController({
      originalTarget: target(),
      captureTarget: () => target(),
      isKeyboardClear: () => keyboardClear,
      dispatchUnicode,
    });

    await controller.onCommittedUpdate('hel');
    await controller.onCommittedUpdate('hello');
    expect(dispatchUnicode).not.toHaveBeenCalled();

    keyboardClear = true;
    await controller.onKeyboardStateChanged();
    expect(dispatchUnicode).toHaveBeenCalledTimes(1);
    expect(dispatchUnicode).toHaveBeenCalledWith('hello');
  });

  it('permanently halts live insertion when the exact original target is not foreground', async () => {
    const onHalted = mock(() => undefined);
    const controller = new LiveDictationController({
      originalTarget: target({ hwnd: 1 }),
      captureTarget: () => target({ hwnd: 2 }),
      isKeyboardClear: () => true,
      dispatchUnicode: mock(() => successDispatch('x')),
      onHalted,
    });

    await controller.onCommittedUpdate('hello');
    expect(controller.getState().halted).toBe(true);
    expect(onHalted).toHaveBeenCalledWith('target-changed');
    expect(controller.getState().dispatchedProjectedLength).toBe(0);
  });

  it('halts without advancing on partial SendInput acceptance', async () => {
    const controller = new LiveDictationController({
      originalTarget: target(),
      captureTarget: () => target(),
      isKeyboardClear: () => true,
      dispatchUnicode: () => ({
        acceptedEvents: 1,
        expectedEvents: 4,
        certainty: 'ambiguous-partial',
        recovery: 'halt',
        advanceCursor: false,
      }),
    });

    await controller.onCommittedUpdate('hi');
    expect(controller.getState().halted).toBe(true);
    expect(controller.getState().uncertain).toBe(true);
    expect(controller.getState().dispatchedProjectedLength).toBe(0);
  });

  it('flushes remaining projected text during finalization', async () => {
    const dispatchUnicode = mock((text: string) => successDispatch(text));
    const controller = new LiveDictationController({
      originalTarget: target(),
      captureTarget: () => target(),
      isKeyboardClear: () => true,
      dispatchUnicode,
    });

    await controller.onCommittedUpdate('hello ');
    expect(dispatchUnicode).toHaveBeenCalledWith('hello');
    await controller.finalize('hello ');
    expect(dispatchUnicode).toHaveBeenLastCalledWith(' ');
    expect(controller.getState().dispatchedProjectedLength).toBe(6);
  });
});
