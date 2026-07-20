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

  it('toggles dictation on fresh presses of the same chord', async () => {
    const { KeyboardHook, keyboardTestKeyCodes } = await import(`../native/keyboard?test=${Date.now()}-toggle-dictation`);
    const hook = new KeyboardHook();
    const started = mock();
    const stopped = mock();

    hook.start(started, stopped, () => true, () => 'toggle');
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, false);

    expect(started).toHaveBeenCalledWith('dictation');
    expect(stopped).not.toHaveBeenCalled();

    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);

    expect(started).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('starts a clean toggle session on the next press after an external duration stop', async () => {
    const { KeyboardHook, keyboardTestKeyCodes } = await import(`../native/keyboard?test=${Date.now()}-toggle-external-stop`);
    const hook = new KeyboardHook();
    const started = mock();
    const stopped = mock();

    hook.start(started, stopped, () => true, () => 'toggle');
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, false);
    hook.recordingEndedExternally();
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);

    expect(started).toHaveBeenCalledTimes(2);
    expect(stopped).not.toHaveBeenCalled();
  });

  it('requires a full chord release and ignores repeated key-down events in toggle mode', async () => {
    const { KeyboardHook, keyboardTestKeyCodes } = await import(`../native/keyboard?test=${Date.now()}-toggle-repeat`);
    const hook = new KeyboardHook();
    const stopped = mock();

    hook.start(mock(), stopped, () => true, () => 'toggle');
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);

    expect(stopped).not.toHaveBeenCalled();

    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);

    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('does not rearm a toggle while its Win key is still physically held', async () => {
    const { KeyboardHook, keyboardTestKeyCodes } = await import(`../native/keyboard?test=${Date.now()}-toggle-held-win`);
    const hook = new KeyboardHook();
    const started = mock();

    hook.start(started, mock(), () => true, () => 'toggle');
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);

    hook.handleKeyForTest(keyboardTestKeyCodes.letterA, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);

    expect(started).toHaveBeenCalledTimes(1);
  });

  it('ignores the other recording binding while a toggle recording is active', async () => {
    const { KeyboardHook, keyboardTestKeyCodes } = await import(`../native/keyboard?test=${Date.now()}-toggle-binding`);
    const hook = new KeyboardHook();
    const started = mock();
    const stopped = mock();

    hook.start(started, stopped, () => true, () => 'toggle');
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, false);

    hook.handleKeyForTest(keyboardTestKeyCodes.leftAlt, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);

    expect(started).toHaveBeenCalledTimes(1);
    expect(stopped).not.toHaveBeenCalled();

    hook.handleKeyForTest(keyboardTestKeyCodes.leftAlt, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);

    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('applies activation-mode changes to the next recording', async () => {
    const { KeyboardHook, keyboardTestKeyCodes } = await import(`../native/keyboard?test=${Date.now()}-mode-change`);
    const hook = new KeyboardHook();
    const stopped = mock();
    let activationMode: 'push-to-talk' | 'toggle' = 'toggle';

    hook.start(mock(), stopped, () => true, () => activationMode);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);
    activationMode = 'push-to-talk';
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, false);

    expect(stopped).not.toHaveBeenCalled();

    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftControl, false);

    expect(stopped).toHaveBeenCalledTimes(2);
  });

  it('toggles Agent Mode with fresh Alt+Win presses', async () => {
    const { KeyboardHook, keyboardTestKeyCodes } = await import(`../native/keyboard?test=${Date.now()}-toggle-agent`);
    const hook = new KeyboardHook();
    const started = mock();
    const stopped = mock();

    hook.start(started, stopped, () => true, () => 'toggle');
    hook.handleKeyForTest(keyboardTestKeyCodes.leftAlt, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftAlt, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, false);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftAlt, true);
    hook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);

    expect(started).toHaveBeenCalledWith('agent');
    expect(started).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('starts agent recording for Alt+Win only when Agent Mode is enabled', async () => {
    const { KeyboardHook, keyboardTestKeyCodes } = await import(`../native/keyboard?test=${Date.now()}-agent`);
    const disabledHook = new KeyboardHook();
    const enabledHook = new KeyboardHook();
    const disabledStart = mock();
    const enabledStart = mock();
    const enabledStop = mock();

    disabledHook.start(disabledStart, mock(), () => false);
    disabledHook.handleKeyForTest(keyboardTestKeyCodes.leftAlt, true);
    disabledHook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);

    enabledHook.start(enabledStart, enabledStop, () => true);
    enabledHook.handleKeyForTest(keyboardTestKeyCodes.leftAlt, true);
    enabledHook.handleKeyForTest(keyboardTestKeyCodes.leftWin, true);
    enabledHook.handleKeyForTest(keyboardTestKeyCodes.leftAlt, false);

    expect(disabledStart).not.toHaveBeenCalled();
    expect(enabledStart).toHaveBeenCalledWith('agent');
    expect(enabledStop).toHaveBeenCalledTimes(1);
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
