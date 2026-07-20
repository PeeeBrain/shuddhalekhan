import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ShortcutBinding } from '../../types/ipc';

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

type HookModule = typeof import('../native/keyboard');

async function importHook(testName: string): Promise<HookModule> {
  return import(`../native/keyboard?test=${Date.now()}-${testName}`);
}

interface HookHarness {
  hook: InstanceType<HookModule['KeyboardHook']>;
  started: ReturnType<typeof mock>;
  stopped: ReturnType<typeof mock>;
  keys: HookModule['keyboardTestKeyCodes'];
  bindings: { dictation: ShortcutBinding | null; agent: ShortcutBinding | null };
  modes: { dictation: 'push-to-talk' | 'toggle'; agent: 'push-to-talk' | 'toggle' };
  agentEnabled: boolean;
}

function createHarness(
  hookModule: HookModule,
  overrides: Partial<{
    dictationBinding: ShortcutBinding | null;
    agentBinding: ShortcutBinding | null;
    dictationMode: 'push-to-talk' | 'toggle';
    agentMode: 'push-to-talk' | 'toggle';
    agentEnabled: boolean;
  }> = {},
): HookHarness {
  const hook = new hookModule.KeyboardHook();
  const started = mock();
  const stopped = mock();
  const harness: HookHarness = {
    hook,
    started,
    stopped,
    keys: hookModule.keyboardTestKeyCodes,
    bindings: {
      dictation: overrides.dictationBinding === undefined
        ? { keyCode: null, modifiers: ['ctrl', 'win'] }
        : overrides.dictationBinding,
      agent: overrides.agentBinding === undefined
        ? { keyCode: null, modifiers: ['alt', 'win'] }
        : overrides.agentBinding,
    },
    modes: {
      dictation: overrides.dictationMode ?? 'push-to-talk',
      agent: overrides.agentMode ?? 'push-to-talk',
    },
    agentEnabled: overrides.agentEnabled ?? true,
  };
  hook.start({
    onStart: started,
    onStop: stopped,
    isAgentModeEnabled: () => harness.agentEnabled,
    getBinding: (intent) => harness.bindings[intent],
    getActivationMode: (intent) => harness.modes[intent],
  });
  return harness;
}

describe('KeyboardHook mode detection', () => {
  beforeEach(() => {
    user32Functions.clear();
    kernel32Functions.clear();
  });

  it('starts dictation for Ctrl+Win and stops when the chord is released', async () => {
    const hookModule = await importHook('dictation');
    const { hook, started, stopped, keys } = createHarness(hookModule);

    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);
    hook.handleKeyForTest(keys.leftControl, false);

    expect(started).toHaveBeenCalledWith('dictation');
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('toggles dictation on fresh presses of the same chord', async () => {
    const hookModule = await importHook('toggle-dictation');
    const { hook, started, stopped, keys } = createHarness(hookModule, { dictationMode: 'toggle' });

    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);
    hook.handleKeyForTest(keys.leftControl, false);
    hook.handleKeyForTest(keys.leftWin, false);

    expect(started).toHaveBeenCalledWith('dictation');
    expect(stopped).not.toHaveBeenCalled();

    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);

    expect(started).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('starts a clean toggle session on the next press after an external duration stop', async () => {
    const hookModule = await importHook('toggle-external-stop');
    const { hook, started, stopped, keys } = createHarness(hookModule, { dictationMode: 'toggle' });

    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);
    hook.handleKeyForTest(keys.leftControl, false);
    hook.handleKeyForTest(keys.leftWin, false);
    hook.recordingEndedExternally();
    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);

    expect(started).toHaveBeenCalledTimes(2);
    expect(stopped).not.toHaveBeenCalled();
  });

  it('requires a full chord release and ignores repeated key-down events in toggle mode', async () => {
    const hookModule = await importHook('toggle-repeat');
    const { hook, stopped, keys } = createHarness(hookModule, { dictationMode: 'toggle' });

    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);
    hook.handleKeyForTest(keys.leftWin, true);
    hook.handleKeyForTest(keys.leftWin, false);
    hook.handleKeyForTest(keys.leftWin, true);

    expect(stopped).not.toHaveBeenCalled();

    hook.handleKeyForTest(keys.leftWin, false);
    hook.handleKeyForTest(keys.leftControl, false);
    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);

    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('does not rearm a toggle while its Win key is still physically held', async () => {
    const hookModule = await importHook('toggle-held-win');
    const { hook, started, keys } = createHarness(hookModule, { dictationMode: 'toggle' });

    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);
    hook.handleKeyForTest(keys.leftControl, false);
    hook.handleKeyForTest(keys.leftWin, false);
    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);

    hook.handleKeyForTest(keys.letterA, true);
    hook.handleKeyForTest(keys.leftControl, false);
    hook.handleKeyForTest(keys.leftWin, true);
    hook.handleKeyForTest(keys.leftControl, true);

    expect(started).toHaveBeenCalledTimes(1);
  });

  it('ignores the other recording binding while a toggle recording is active', async () => {
    const hookModule = await importHook('toggle-binding');
    const { hook, started, stopped, keys } = createHarness(hookModule, { dictationMode: 'toggle' });

    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);
    hook.handleKeyForTest(keys.leftControl, false);
    hook.handleKeyForTest(keys.leftWin, false);

    hook.handleKeyForTest(keys.leftAlt, true);
    hook.handleKeyForTest(keys.leftWin, true);

    expect(started).toHaveBeenCalledTimes(1);
    expect(stopped).not.toHaveBeenCalled();

    hook.handleKeyForTest(keys.leftAlt, false);
    hook.handleKeyForTest(keys.leftWin, false);
    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);

    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('applies activation-mode changes to the next recording', async () => {
    const hookModule = await importHook('mode-change');
    const harness = createHarness(hookModule, { dictationMode: 'toggle' });
    const { hook, stopped, keys } = harness;

    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);
    harness.modes.dictation = 'push-to-talk';
    hook.handleKeyForTest(keys.leftControl, false);
    hook.handleKeyForTest(keys.leftWin, false);

    expect(stopped).not.toHaveBeenCalled();

    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);
    hook.handleKeyForTest(keys.leftControl, false);
    hook.handleKeyForTest(keys.leftWin, false);
    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);
    hook.handleKeyForTest(keys.leftControl, false);

    expect(stopped).toHaveBeenCalledTimes(2);
  });

  it('toggles Agent Mode with fresh Alt+Win presses', async () => {
    const hookModule = await importHook('toggle-agent');
    const { hook, started, stopped, keys } = createHarness(hookModule, { agentMode: 'toggle' });

    hook.handleKeyForTest(keys.leftAlt, true);
    hook.handleKeyForTest(keys.leftWin, true);
    hook.handleKeyForTest(keys.leftAlt, false);
    hook.handleKeyForTest(keys.leftWin, false);
    hook.handleKeyForTest(keys.leftAlt, true);
    hook.handleKeyForTest(keys.leftWin, true);

    expect(started).toHaveBeenCalledWith('agent');
    expect(started).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('starts agent recording for Alt+Win only when Agent Mode is enabled', async () => {
    const hookModule = await importHook('agent');
    const disabledHarness = createHarness(hookModule, { agentEnabled: false });
    const enabledHarness = createHarness(hookModule, { agentEnabled: true });

    disabledHarness.hook.handleKeyForTest(disabledHarness.keys.leftAlt, true);
    disabledHarness.hook.handleKeyForTest(disabledHarness.keys.leftWin, true);

    enabledHarness.hook.handleKeyForTest(enabledHarness.keys.leftAlt, true);
    enabledHarness.hook.handleKeyForTest(enabledHarness.keys.leftWin, true);
    enabledHarness.hook.handleKeyForTest(enabledHarness.keys.leftAlt, false);

    expect(disabledHarness.started).not.toHaveBeenCalled();
    expect(enabledHarness.started).toHaveBeenCalledWith('agent');
    expect(enabledHarness.stopped).toHaveBeenCalledTimes(1);
  });

  it('does not start dictation when Alt is also held', async () => {
    const hookModule = await importHook('modifiers');
    const { hook, started, keys } = createHarness(hookModule);

    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftAlt, true);
    hook.handleKeyForTest(keys.leftWin, true);

    expect(started).not.toHaveBeenCalled();
  });

  it('normalizes left and right modifiers to one logical identity', async () => {
    const hookModule = await importHook('normalize');
    const { hook, started, stopped, keys } = createHarness(hookModule);

    hook.handleKeyForTest(keys.rightControl, true);
    hook.handleKeyForTest(keys.rightWin, true);

    expect(started).toHaveBeenCalledWith('dictation');

    hook.handleKeyForTest(keys.rightWin, false);

    expect(stopped).toHaveBeenCalledTimes(1);
  });
});

describe('KeyboardHook configurable bindings', () => {
  beforeEach(() => {
    user32Functions.clear();
    kernel32Functions.clear();
  });

  it('triggers on an ordinary key plus modifiers and consumes the ordinary key', async () => {
    const hookModule = await importHook('ordinary-chord');
    const { hook, started, stopped, keys } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: ['ctrl', 'shift'] },
    });

    const consumedCtrl = hook.handleKeyForTest(keys.leftControl, true);
    const consumedShift = hook.handleKeyForTest(keys.leftShift, true);
    const consumedKey = hook.handleKeyForTest(0x52, true);

    expect(started).toHaveBeenCalledWith('dictation');
    expect(consumedCtrl).toBe(false);
    expect(consumedShift).toBe(false);
    expect(consumedKey).toBe(true);

    const consumedUp = hook.handleKeyForTest(0x52, false);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(consumedUp).toBe(true);
  });

  it('continues consuming an ordinary trigger when a modifier is released first', async () => {
    const hookModule = await importHook('ordinary-chord-release-order');
    const { hook, stopped, keys } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: ['ctrl'] },
    });

    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(0x52, true);
    expect(hook.handleKeyForTest(keys.leftControl, false)).toBe(false);
    expect(stopped).toHaveBeenCalledTimes(1);

    expect(hook.handleKeyForTest(0x52, true)).toBe(true);
    expect(hook.handleKeyForTest(0x52, false)).toBe(true);
  });

  it('does not trigger an ordinary chord when the modifier set differs', async () => {
    const hookModule = await importHook('ordinary-chord-mismatch');
    const { hook, started, keys } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: ['ctrl'] },
    });

    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftAlt, true);
    const consumed = hook.handleKeyForTest(0x52, true);

    expect(started).not.toHaveBeenCalled();
    expect(consumed).toBe(false);
  });

  it('supports a single key in push-to-talk, ignores repeats, and consumes every event', async () => {
    const hookModule = await importHook('single-key-ptt');
    const { hook, started, stopped } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: [] },
    });

    expect(hook.handleKeyForTest(0x52, true)).toBe(true);
    expect(started).toHaveBeenCalledWith('dictation');

    // Held-key repeats neither retrigger nor leak text.
    expect(hook.handleKeyForTest(0x52, true)).toBe(true);
    expect(hook.handleKeyForTest(0x52, true)).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);

    expect(hook.handleKeyForTest(0x52, false)).toBe(true);
    expect(stopped).toHaveBeenCalledTimes(1);

    // After release the key types normally again.
    expect(hook.handleKeyForTest(0x52, true)).toBe(true);
    expect(started).toHaveBeenCalledTimes(2);
  });

  it('supports a single key in toggle mode with repeat suppression', async () => {
    const hookModule = await importHook('single-key-toggle');
    const { hook, started, stopped } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: [] },
      dictationMode: 'toggle',
    });

    expect(hook.handleKeyForTest(0x52, true)).toBe(true);
    expect(hook.handleKeyForTest(0x52, false)).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);
    expect(stopped).not.toHaveBeenCalled();

    expect(hook.handleKeyForTest(0x52, true)).toBe(true);
    expect(hook.handleKeyForTest(0x52, false)).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('supports function and navigation keys as ordinary keys', async () => {
    const hookModule = await importHook('function-key');
    const { hook, started, stopped, keys } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x74, modifiers: [] },
      agentBinding: { keyCode: 0x26, modifiers: ['win'] },
    });

    hook.handleKeyForTest(0x74, true);
    hook.handleKeyForTest(0x74, false);
    expect(started).toHaveBeenCalledWith('dictation');
    expect(stopped).toHaveBeenCalledTimes(1);

    hook.handleKeyForTest(keys.leftWin, true);
    hook.handleKeyForTest(0x26, true);
    expect(started).toHaveBeenCalledWith('agent');
  });

  it('supports a custom modifier-only binding', async () => {
    const hookModule = await importHook('modifier-only');
    const { hook, started, keys } = createHarness(hookModule, {
      dictationBinding: { keyCode: null, modifiers: ['ctrl', 'shift'] },
    });

    hook.handleKeyForTest(keys.leftControl, true);
    expect(started).not.toHaveBeenCalled();
    hook.handleKeyForTest(keys.rightShift, true);

    expect(started).toHaveBeenCalledWith('dictation');
  });

  it('lets unrelated keys pass through while a chord session is recording', async () => {
    const hookModule = await importHook('unrelated-keys');
    const { hook, started, keys } = createHarness(hookModule);

    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);
    expect(started).toHaveBeenCalledWith('dictation');

    expect(hook.handleKeyForTest(keys.letterA, true)).toBe(false);
    expect(hook.handleKeyForTest(keys.letterA, false)).toBe(false);
  });

  it('reserves no key when an intent is unassigned', async () => {
    const hookModule = await importHook('unassigned');
    const { hook, started, keys } = createHarness(hookModule, { dictationBinding: null });

    expect(hook.handleKeyForTest(keys.leftControl, true)).toBe(false);
    expect(hook.handleKeyForTest(keys.leftWin, true)).toBe(false);

    expect(started).not.toHaveBeenCalled();
  });

  it('keeps the Agent Mode binding dormant while Agent Mode is disabled', async () => {
    const hookModule = await importHook('dormant-agent');
    const harness = createHarness(hookModule, { agentEnabled: false });
    const { hook, started, keys } = harness;

    hook.handleKeyForTest(keys.leftAlt, true);
    hook.handleKeyForTest(keys.leftWin, true);
    hook.handleKeyForTest(keys.leftAlt, false);
    hook.handleKeyForTest(keys.leftWin, false);
    expect(started).not.toHaveBeenCalled();

    harness.agentEnabled = true;
    hook.handleKeyForTest(keys.leftAlt, true);
    hook.handleKeyForTest(keys.leftWin, true);
    expect(started).toHaveBeenCalledWith('agent');
  });

  it('applies binding changes to the next press without restarting the hook', async () => {
    const hookModule = await importHook('dynamic-binding');
    const harness = createHarness(hookModule);
    const { hook, started, keys } = harness;

    harness.bindings.dictation = { keyCode: 0x52, modifiers: [] };

    hook.handleKeyForTest(0x52, true);
    expect(started).toHaveBeenCalledWith('dictation');

    hook.handleKeyForTest(0x52, false);
    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('keeps an active session on its original binding after a mid-session binding change', async () => {
    const hookModule = await importHook('mid-session-change');
    const harness = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: [] },
    });
    const { hook, started, stopped } = harness;

    hook.handleKeyForTest(0x52, true);
    expect(started).toHaveBeenCalledWith('dictation');

    harness.bindings.dictation = { keyCode: 0x54, modifiers: [] };
    hook.handleKeyForTest(0x52, false);

    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('uses independent activation modes per intent', async () => {
    const hookModule = await importHook('per-intent-modes');
    const { hook, started, stopped, keys } = createHarness(hookModule, {
      dictationMode: 'toggle',
      agentMode: 'push-to-talk',
    });

    // Dictation toggle: press and release, still recording.
    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);
    hook.handleKeyForTest(keys.leftControl, false);
    hook.handleKeyForTest(keys.leftWin, false);
    expect(started).toHaveBeenCalledWith('dictation');
    expect(stopped).not.toHaveBeenCalled();

    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);
    expect(stopped).toHaveBeenCalledTimes(1);
    hook.handleKeyForTest(keys.leftControl, false);
    hook.handleKeyForTest(keys.leftWin, false);

    // Agent push-to-talk: stops on release.
    hook.handleKeyForTest(keys.leftAlt, true);
    hook.handleKeyForTest(keys.leftWin, true);
    expect(started).toHaveBeenCalledWith('agent');
    hook.handleKeyForTest(keys.leftWin, false);
    expect(stopped).toHaveBeenCalledTimes(2);
  });
});

describe('KeyboardHook pause and capture suspension', () => {
  beforeEach(() => {
    user32Functions.clear();
    kernel32Functions.clear();
  });

  it('prevents new sessions while paused and lets trigger keys pass through', async () => {
    const hookModule = await importHook('pause');
    const { hook, started } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: [] },
    });

    hook.setPaused(true);
    expect(hook.isPaused()).toBe(true);

    expect(hook.handleKeyForTest(0x52, true)).toBe(false);
    expect(hook.handleKeyForTest(0x52, false)).toBe(false);
    expect(started).not.toHaveBeenCalled();

    hook.setPaused(false);
    expect(hook.handleKeyForTest(0x52, true)).toBe(true);
    expect(started).toHaveBeenCalledWith('dictation');
  });

  it('leaves an active session’s completion semantics intact when paused mid-session', async () => {
    const hookModule = await importHook('pause-mid-session');
    const { hook, started, stopped } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: [] },
    });

    hook.handleKeyForTest(0x52, true);
    expect(started).toHaveBeenCalledWith('dictation');

    hook.setPaused(true);
    expect(hook.handleKeyForTest(0x52, false)).toBe(true);
    expect(stopped).toHaveBeenCalledTimes(1);

    expect(hook.handleKeyForTest(0x52, true)).toBe(false);
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('suspends activation during inline capture and always restores it', async () => {
    const hookModule = await importHook('capture');
    const { hook, started, keys } = createHarness(hookModule);

    hook.setCaptureSuspended(true);
    expect(hook.handleKeyForTest(keys.leftControl, true)).toBe(false);
    expect(hook.handleKeyForTest(keys.leftWin, true)).toBe(false);
    expect(started).not.toHaveBeenCalled();

    hook.setCaptureSuspended(false);
    hook.handleKeyForTest(keys.leftWin, false);
    hook.handleKeyForTest(keys.leftControl, false);
    hook.handleKeyForTest(keys.leftControl, true);
    hook.handleKeyForTest(keys.leftWin, true);
    expect(started).toHaveBeenCalledWith('dictation');
  });
});
