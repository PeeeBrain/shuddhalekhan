import { beforeEach, describe, expect, it, mock } from 'bun:test';

const koffiHandle = { id: 'callback' };
const user32Functions = new Map<string, ReturnType<typeof mock>>();
const kernel32Functions = new Map<string, ReturnType<typeof mock>>();

mock.module('koffi', () => ({
  default: {
    load: mock((library: string) => ({
      func: mock((signature: string) => {
        const fn = mock(() => {
          if (signature.includes('SetWindowsHookExW')) return 1;
          if (signature.includes('CallNextHookEx')) return 0n;
          if (signature.includes('UnhookWindowsHookEx')) return true;
          if (signature.includes('GetModuleHandleW')) return 1;
          return 0;
        });
        if (library === 'user32.dll') user32Functions.set(signature, fn);
        if (library === 'kernel32.dll') kernel32Functions.set(signature, fn);
        return fn;
      }),
    })),
    struct: mock((_name: string, shape: unknown) => shape),
    proto: mock(() => ({})),
    pointer: mock((value: unknown) => value),
    register: mock(() => koffiHandle),
    unregister: mock(),
    decode: mock(),
  },
}));

describe('KeyboardHook mode detection', () => {
  beforeEach(() => {
    user32Functions.clear();
    kernel32Functions.clear();
  });

  it('starts dictation for Ctrl+Win and stops when the chord is released', async () => {
    const { KeyboardHook, keyboardTestKeyCodes } = await import(`../native/keyboard?test=${Date.now()}-dictation`);
    const hook = new KeyboardHook();
    const started = mock();
    const stopped = mock();

    hook.start(started, stopped, () => true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, false);

    expect(started).toHaveBeenCalledWith('dictation');
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('starts agent recording for Alt+Win only when Agent Mode is enabled', async () => {
    const { KeyboardHook, keyboardTestKeyCodes } = await import(`../native/keyboard?test=${Date.now()}-agent`);
    const disabledHook = new KeyboardHook();
    const enabledHook = new KeyboardHook();
    const disabledStart = mock();
    const enabledStart = mock();

    disabledHook.start(disabledStart, mock(), () => false);
    disabledHook.handleKeyForTest(keyboardTestKeyCodes.leftAlt, true);
    disabledHook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);

    enabledHook.start(enabledStart, mock(), () => true);
    enabledHook.handleKeyForTest(keyboardTestKeyCodes.leftAlt, true);
    enabledHook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);

    expect(disabledStart).not.toHaveBeenCalled();
    expect(enabledStart).toHaveBeenCalledWith('agent');
  });

  it('does not start dictation when Alt is also held', async () => {
    const { KeyboardHook, keyboardTestKeyCodes } = await import(`../native/keyboard?test=${Date.now()}-modifiers`);
    const hook = new KeyboardHook();
    const started = mock();

    hook.start(started, mock(), () => true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftAlt, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);

    expect(started).not.toHaveBeenCalled();
  });
});
