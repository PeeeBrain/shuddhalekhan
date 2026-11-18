import { describe, expect, it, mock } from 'bun:test';
import type { ShortcutBinding } from '../../types/ipc';

type KeyboardEvent = { vkCode: number; time: number };
type KeyboardCallback = (code: number, message: bigint, event: KeyboardEvent) => bigint;
const nextHookResult = 37n;
let registeredHook: { handle: symbol; callback: KeyboardCallback } | undefined;
let installedCallback: KeyboardCallback | undefined;

mock.module('koffi', () => ({
  default: {
    load: mock(() => ({
      func: (signature: string) => {
        if (signature.includes('SetWindowsHookExW')) {
          return (_hookId: number, handle: symbol) => {
            installedCallback = registeredHook?.handle === handle ? registeredHook.callback : undefined;
            return installedCallback ? 1 : 0;
          };
        }
        return () => signature.includes('CallNextHookEx') ? nextHookResult : 1;
      },
    })),
    struct: mock((_name: string, shape: unknown) => shape),
    proto: mock(() => ({})),
    pointer: mock((value: unknown) => value),
    register: mock((callback: KeyboardCallback) => {
      const handle = Symbol('keyboard callback');
      registeredHook = { handle, callback };
      return handle;
    }),
    unregister: mock(),
    decode: (event: KeyboardEvent) => event,
  },
}));

// The state machine is platform-neutral; keep Linux test runs off real evdev.
// Spread the real module: Bun module mocks leak into other test files.
const linuxInput = await import('../native/linux-input');
const startEvdevKeyboardReader = mock(
  (_onKey: Parameters<typeof linuxInput.startEvdevKeyboardReader>[0]): () => void => () => undefined,
);
mock.module('../native/linux-input', () => ({
  ...linuxInput,
  startEvdevKeyboardReader,
  prepareVirtualKeyboard: () => undefined,
}));
// Desktop shortcuts are unavailable unless a test hands the hook a fake backend.
type ShortcutHandler = (intent: 'dictation' | 'agent', isDown: boolean, at?: number) => void;
const connectLinuxShortcuts = mock(
  (_events: { onShortcut: ShortcutHandler; onLost: () => void }): Promise<unknown> =>
    Promise.reject(new Error('no desktop shortcuts')),
);
mock.module('../desktop/linux-shortcuts', () => ({ connectLinuxShortcuts }));

type HookModule = typeof import('../native/keyboard');
type KeyboardHook = InstanceType<HookModule['KeyboardHook']>;
const nativeCallbacks = new WeakMap<KeyboardHook, KeyboardCallback>();

const keys = {
  leftShift: 0xa0,
  rightShift: 0xa1,
  leftControl: 0xa2,
  rightControl: 0xa3,
  leftAlt: 0xa4,
  rightAlt: 0xa5,
  leftWin: 0x5b,
  rightWin: 0x5c,
  letterA: 0x41,
};

function key(hook: KeyboardHook, vkCode: number, isDown: boolean, time = 0): boolean {
  const callback = nativeCallbacks.get(hook);
  if (!callback) throw new Error('Expected an installed Windows keyboard callback');
  const result = callback(0, isDown ? 0x0100n : 0x0101n, { vkCode, time });
  if (result === 1n) return true;
  expect(result).toBe(nextHookResult);
  return false;
}

function startWindowsHook(hook: KeyboardHook, options: Parameters<KeyboardHook['start']>[0]): void {
  const platform = process.platform;
  installedCallback = undefined;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    hook.start(options);
  } finally {
    Object.defineProperty(process, 'platform', { value: platform });
  }
  if (!installedCallback) throw new Error('The Windows keyboard callback was not installed');
  nativeCallbacks.set(hook, installedCallback);
}

async function importHook(testName: string): Promise<HookModule> {
  return import(`../native/keyboard?test=${Date.now()}-${testName}`);
}

interface HookHarness {
  hook: InstanceType<HookModule['KeyboardHook']>;
  started: ReturnType<typeof mock>;
  stopped: ReturnType<typeof mock>;
  keys: typeof keys;
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
  start = startWindowsHook,
): HookHarness {
  const hook = new hookModule.KeyboardHook();
  const started = mock();
  const stopped = mock();
  const harness: HookHarness = {
    hook,
    started,
    stopped,
    keys,
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
  start(hook, {
    onStart: started,
    onStop: stopped,
    isAgentModeEnabled: () => harness.agentEnabled,
    getBinding: (intent) => harness.bindings[intent],
    getActivationMode: (intent) => harness.modes[intent],
  });
  return harness;
}

describe('KeyboardHook mode detection', () => {
  it('waits for the entire physical recording chord to release before final paste', async () => {
    const { hook, keys } = createHarness(await importHook('final-paste-release'));
    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    const waiting = hook.waitForKeysReleased(new AbortController().signal);
    let released = false;
    void waiting.then(value => { released = value; });
    key(hook, keys.leftControl, false);
    await Promise.resolve();
    expect(released).toBe(false);
    key(hook, keys.leftWin, false);
    expect(await waiting).toBe(true);
    hook.stop();
  });

  it('cancels a pending release wait without reviving it when the keys later release', async () => {
    const { hook, keys } = createHarness(await importHook('cancel-final-paste-release'));
    const controller = new AbortController();
    key(hook, keys.leftWin, true);
    const waiting = hook.waitForKeysReleased(controller.signal);
    controller.abort();
    expect(await waiting).toBe(false);
    key(hook, keys.leftWin, false);
    expect(await hook.waitForKeysReleased(new AbortController().signal)).toBe(true);
    hook.stop();
  });

  it('starts dictation for Ctrl+Win and stops when the chord is released', async () => {
    const hookModule = await importHook('dictation');
    const { hook, started, stopped, keys } = createHarness(hookModule);

    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    key(hook, keys.leftControl, false);

    expect(started).toHaveBeenCalledWith('dictation');
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('reports the push-to-talk hold across a Windows tick count wraparound', async () => {
    const hookModule = await importHook('hold-length');
    const { hook, stopped, keys } = createHarness(hookModule);

    // The Windows tick count wraps at 2^32 ms mid-hold.
    key(hook, keys.leftControl, true, 2 ** 32 - 100);
    key(hook, keys.leftWin, true, 2 ** 32 - 90);
    key(hook, keys.leftWin, false, 150);
    key(hook, keys.leftControl, false, 160);
    expect(stopped.mock.calls).toEqual([[240]]);
  });

  it('consumes every configured modifier release when Win is pressed first', async () => {
    const hookModule = await importHook('modifier-release-consumption');
    const { hook, keys } = createHarness(hookModule, { dictationMode: 'toggle' });

    key(hook, keys.leftWin, true);
    expect(key(hook, keys.leftControl, true)).toBe(true);
    expect(key(hook, keys.leftControl, false)).toBe(true);
    expect(key(hook, keys.leftWin, false)).toBe(true);
  });

  it('toggles dictation on fresh presses of the same chord', async () => {
    const hookModule = await importHook('toggle-dictation');
    const { hook, started, stopped, keys } = createHarness(hookModule, { dictationMode: 'toggle' });

    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    key(hook, keys.leftControl, false);
    key(hook, keys.leftWin, false);

    expect(started).toHaveBeenCalledWith('dictation');
    expect(stopped).not.toHaveBeenCalled();

    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);

    expect(started).toHaveBeenCalledTimes(1);
    expect(stopped.mock.calls).toEqual([[null]]);
  });

  it('starts a clean toggle session on the next press after an external duration stop', async () => {
    const hookModule = await importHook('toggle-external-stop');
    const { hook, started, stopped, keys } = createHarness(hookModule, { dictationMode: 'toggle' });

    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    key(hook, keys.leftControl, false);
    key(hook, keys.leftWin, false);
    hook.recordingEndedExternally();
    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);

    expect(started).toHaveBeenCalledTimes(2);
    expect(stopped).not.toHaveBeenCalled();
  });

  it('requires a full chord release and ignores repeated key-down events in toggle mode', async () => {
    const hookModule = await importHook('toggle-repeat');
    const { hook, stopped, keys } = createHarness(hookModule, { dictationMode: 'toggle' });

    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    key(hook, keys.leftWin, true);
    key(hook, keys.leftWin, false);
    key(hook, keys.leftWin, true);

    expect(stopped).not.toHaveBeenCalled();

    key(hook, keys.leftWin, false);
    key(hook, keys.leftControl, false);
    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);

    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('does not rearm a toggle while its Win key is still physically held', async () => {
    const hookModule = await importHook('toggle-held-win');
    const { hook, started, keys } = createHarness(hookModule, { dictationMode: 'toggle' });

    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    key(hook, keys.leftControl, false);
    key(hook, keys.leftWin, false);
    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);

    key(hook, keys.letterA, true);
    key(hook, keys.leftControl, false);
    key(hook, keys.leftWin, true);
    key(hook, keys.leftControl, true);

    expect(started).toHaveBeenCalledTimes(1);
  });

  it('ignores the other recording binding while a toggle recording is active', async () => {
    const hookModule = await importHook('toggle-binding');
    const { hook, started, stopped, keys } = createHarness(hookModule, { dictationMode: 'toggle' });

    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    key(hook, keys.leftControl, false);
    key(hook, keys.leftWin, false);

    key(hook, keys.leftAlt, true);
    key(hook, keys.leftWin, true);

    expect(started).toHaveBeenCalledTimes(1);
    expect(stopped).not.toHaveBeenCalled();

    key(hook, keys.leftAlt, false);
    key(hook, keys.leftWin, false);
    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);

    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('applies activation-mode changes to the next recording', async () => {
    const hookModule = await importHook('mode-change');
    const harness = createHarness(hookModule, { dictationMode: 'toggle' });
    const { hook, stopped, keys } = harness;

    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    harness.modes.dictation = 'push-to-talk';
    key(hook, keys.leftControl, false);
    key(hook, keys.leftWin, false);

    expect(stopped).not.toHaveBeenCalled();

    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    key(hook, keys.leftControl, false);
    key(hook, keys.leftWin, false);
    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    key(hook, keys.leftControl, false);

    expect(stopped).toHaveBeenCalledTimes(2);
  });

  it('toggles Agent Mode with fresh Alt+Win presses', async () => {
    const hookModule = await importHook('toggle-agent');
    const { hook, started, stopped, keys } = createHarness(hookModule, { agentMode: 'toggle' });

    key(hook, keys.leftAlt, true);
    key(hook, keys.leftWin, true);
    key(hook, keys.leftAlt, false);
    key(hook, keys.leftWin, false);
    key(hook, keys.leftAlt, true);
    key(hook, keys.leftWin, true);

    expect(started).toHaveBeenCalledWith('agent');
    expect(started).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('starts agent recording for Alt+Win only when Agent Mode is enabled', async () => {
    const hookModule = await importHook('agent');
    const disabledHarness = createHarness(hookModule, { agentEnabled: false });
    const enabledHarness = createHarness(hookModule, { agentEnabled: true });

    key(disabledHarness.hook, disabledHarness.keys.leftAlt, true);
    key(disabledHarness.hook, disabledHarness.keys.leftWin, true);

    key(enabledHarness.hook, enabledHarness.keys.leftAlt, true);
    key(enabledHarness.hook, enabledHarness.keys.leftWin, true);
    key(enabledHarness.hook, enabledHarness.keys.leftAlt, false);

    expect(disabledHarness.started).not.toHaveBeenCalled();
    expect(enabledHarness.started).toHaveBeenCalledWith('agent');
    expect(enabledHarness.stopped).toHaveBeenCalledTimes(1);
  });

  it('does not start dictation when Alt is also held', async () => {
    const hookModule = await importHook('modifiers');
    const { hook, started, keys } = createHarness(hookModule);

    key(hook, keys.leftControl, true);
    key(hook, keys.leftAlt, true);
    key(hook, keys.leftWin, true);

    expect(started).not.toHaveBeenCalled();
  });

  it('normalizes left and right modifiers to one logical identity', async () => {
    const hookModule = await importHook('normalize');
    const { hook, started, stopped, keys } = createHarness(hookModule);

    key(hook, keys.rightControl, true);
    key(hook, keys.rightWin, true);

    expect(started).toHaveBeenCalledWith('dictation');

    key(hook, keys.rightWin, false);

    expect(stopped).toHaveBeenCalledTimes(1);
  });
});

describe('KeyboardHook configurable bindings', () => {
  it('triggers on an ordinary key plus modifiers and consumes the ordinary key', async () => {
    const hookModule = await importHook('ordinary-chord');
    const { hook, started, stopped, keys } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: ['ctrl', 'shift'] },
    });

    const consumedCtrl = key(hook, keys.leftControl, true);
    const consumedShift = key(hook, keys.leftShift, true);
    const consumedKey = key(hook, 0x52, true);

    expect(started).toHaveBeenCalledWith('dictation');
    expect(consumedCtrl).toBe(false);
    expect(consumedShift).toBe(false);
    expect(consumedKey).toBe(true);

    const consumedUp = key(hook, 0x52, false);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(consumedUp).toBe(true);
  });

  it('consumes required modifier releases during an ordinary chord session', async () => {
    const hookModule = await importHook('ordinary-chord-modifier-release');
    const { hook, stopped, keys } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: ['ctrl', 'win'] },
    });

    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    key(hook, 0x52, true);
    expect(key(hook, keys.leftWin, false)).toBe(true);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(key(hook, 0x52, false)).toBe(true);
  });

  it('continues consuming an ordinary trigger when a modifier is released first', async () => {
    const hookModule = await importHook('ordinary-chord-release-order');
    const { hook, stopped, keys } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: ['ctrl'] },
    });

    key(hook, keys.leftControl, true);
    key(hook, 0x52, true);
    expect(key(hook, keys.leftControl, false)).toBe(true);
    expect(stopped).toHaveBeenCalledTimes(1);

    expect(key(hook, 0x52, true)).toBe(true);
    expect(key(hook, 0x52, false)).toBe(true);
  });

  it('does not trigger an ordinary chord when the modifier set differs', async () => {
    const hookModule = await importHook('ordinary-chord-mismatch');
    const { hook, started, keys } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: ['ctrl'] },
    });

    key(hook, keys.leftControl, true);
    key(hook, keys.leftAlt, true);
    const consumed = key(hook, 0x52, true);

    expect(started).not.toHaveBeenCalled();
    expect(consumed).toBe(false);
  });

  it('supports a single key in push-to-talk, ignores repeats, and consumes every event', async () => {
    const hookModule = await importHook('single-key-ptt');
    const { hook, started, stopped } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: [] },
    });

    expect(key(hook, 0x52, true)).toBe(true);
    expect(started).toHaveBeenCalledWith('dictation');

    // Held-key repeats neither retrigger nor leak text.
    expect(key(hook, 0x52, true)).toBe(true);
    expect(key(hook, 0x52, true)).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);

    expect(key(hook, 0x52, false)).toBe(true);
    expect(stopped).toHaveBeenCalledTimes(1);

    // After release the key types normally again.
    expect(key(hook, 0x52, true)).toBe(true);
    expect(started).toHaveBeenCalledTimes(2);
  });

  it('supports a single key in toggle mode with repeat suppression', async () => {
    const hookModule = await importHook('single-key-toggle');
    const { hook, started, stopped } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: [] },
      dictationMode: 'toggle',
    });

    expect(key(hook, 0x52, true)).toBe(true);
    expect(key(hook, 0x52, false)).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);
    expect(stopped).not.toHaveBeenCalled();

    expect(key(hook, 0x52, true)).toBe(true);
    expect(key(hook, 0x52, false)).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('supports function and navigation keys as ordinary keys', async () => {
    const hookModule = await importHook('function-key');
    const { hook, started, stopped, keys } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x74, modifiers: [] },
      agentBinding: { keyCode: 0x26, modifiers: ['win'] },
    });

    key(hook, 0x74, true);
    key(hook, 0x74, false);
    expect(started).toHaveBeenCalledWith('dictation');
    expect(stopped).toHaveBeenCalledTimes(1);

    key(hook, keys.leftWin, true);
    key(hook, 0x26, true);
    expect(started).toHaveBeenCalledWith('agent');
  });

  it('supports a custom modifier-only binding', async () => {
    const hookModule = await importHook('modifier-only');
    const { hook, started, keys } = createHarness(hookModule, {
      dictationBinding: { keyCode: null, modifiers: ['ctrl', 'shift'] },
    });

    key(hook, keys.leftControl, true);
    expect(started).not.toHaveBeenCalled();
    key(hook, keys.rightShift, true);

    expect(started).toHaveBeenCalledWith('dictation');
  });

  it('lets unrelated keys pass through while a chord session is recording', async () => {
    const hookModule = await importHook('unrelated-keys');
    const { hook, started, keys } = createHarness(hookModule);

    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    expect(started).toHaveBeenCalledWith('dictation');

    expect(key(hook, keys.letterA, true)).toBe(false);
    expect(key(hook, keys.letterA, false)).toBe(false);
  });

  it('reserves no key when an intent is unassigned', async () => {
    const hookModule = await importHook('unassigned');
    const { hook, started, keys } = createHarness(hookModule, { dictationBinding: null });

    expect(key(hook, keys.leftControl, true)).toBe(false);
    expect(key(hook, keys.leftWin, true)).toBe(false);

    expect(started).not.toHaveBeenCalled();
  });

  it('keeps the Agent Mode binding dormant while Agent Mode is disabled', async () => {
    const hookModule = await importHook('dormant-agent');
    const harness = createHarness(hookModule, { agentEnabled: false });
    const { hook, started, keys } = harness;

    key(hook, keys.leftAlt, true);
    key(hook, keys.leftWin, true);
    key(hook, keys.leftAlt, false);
    key(hook, keys.leftWin, false);
    expect(started).not.toHaveBeenCalled();

    harness.agentEnabled = true;
    key(hook, keys.leftAlt, true);
    key(hook, keys.leftWin, true);
    expect(started).toHaveBeenCalledWith('agent');
  });

  it('applies binding changes to the next press without restarting the hook', async () => {
    const hookModule = await importHook('dynamic-binding');
    const harness = createHarness(hookModule);
    const { hook, started, keys } = harness;

    harness.bindings.dictation = { keyCode: 0x52, modifiers: [] };

    key(hook, 0x52, true);
    expect(started).toHaveBeenCalledWith('dictation');

    key(hook, 0x52, false);
    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('keeps an active session on its original binding after a mid-session binding change', async () => {
    const hookModule = await importHook('mid-session-change');
    const harness = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: [] },
    });
    const { hook, started, stopped } = harness;

    key(hook, 0x52, true);
    expect(started).toHaveBeenCalledWith('dictation');

    harness.bindings.dictation = { keyCode: 0x54, modifiers: [] };
    key(hook, 0x52, false);

    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('uses independent activation modes per intent', async () => {
    const hookModule = await importHook('per-intent-modes');
    const { hook, started, stopped, keys } = createHarness(hookModule, {
      dictationMode: 'toggle',
      agentMode: 'push-to-talk',
    });

    // Dictation toggle: press and release, still recording.
    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    key(hook, keys.leftControl, false);
    key(hook, keys.leftWin, false);
    expect(started).toHaveBeenCalledWith('dictation');
    expect(stopped).not.toHaveBeenCalled();

    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    expect(stopped).toHaveBeenCalledTimes(1);
    key(hook, keys.leftControl, false);
    key(hook, keys.leftWin, false);

    // Agent push-to-talk: stops on release.
    key(hook, keys.leftAlt, true);
    key(hook, keys.leftWin, true);
    expect(started).toHaveBeenCalledWith('agent');
    key(hook, keys.leftWin, false);
    expect(stopped).toHaveBeenCalledTimes(2);
  });
});

describe('KeyboardHook pause and capture suspension', () => {
  it('prevents new sessions while paused and lets trigger keys pass through', async () => {
    const hookModule = await importHook('pause');
    const { hook, started } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: [] },
    });

    hook.setPaused(true);
    expect(hook.isPaused()).toBe(true);

    expect(key(hook, 0x52, true)).toBe(false);
    expect(key(hook, 0x52, false)).toBe(false);
    expect(started).not.toHaveBeenCalled();

    hook.setPaused(false);
    expect(key(hook, 0x52, true)).toBe(true);
    expect(started).toHaveBeenCalledWith('dictation');
  });

  it('leaves an active session’s completion semantics intact when paused mid-session', async () => {
    const hookModule = await importHook('pause-mid-session');
    const { hook, started, stopped } = createHarness(hookModule, {
      dictationBinding: { keyCode: 0x52, modifiers: [] },
    });

    key(hook, 0x52, true);
    expect(started).toHaveBeenCalledWith('dictation');

    hook.setPaused(true);
    expect(key(hook, 0x52, false)).toBe(true);
    expect(stopped).toHaveBeenCalledTimes(1);

    expect(key(hook, 0x52, true)).toBe(false);
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('suspends activation during inline capture and always restores it', async () => {
    const hookModule = await importHook('capture');
    const { hook, started, keys } = createHarness(hookModule);

    hook.setCaptureSuspended(true);
    expect(key(hook, keys.leftControl, true)).toBe(false);
    expect(key(hook, keys.leftWin, true)).toBe(false);
    expect(started).not.toHaveBeenCalled();

    hook.setCaptureSuspended(false);
    key(hook, keys.leftWin, false);
    key(hook, keys.leftControl, false);
    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    expect(started).toHaveBeenCalledWith('dictation');
  });

  it('does not create phantom active or toggle session when onStart returns false', async () => {
    const hookModule = await importHook('rejected-start');
    const hook = new hookModule.KeyboardHook();
    const started = mock();
    const stopped = mock();

    // Reject the first start attempt, accept the second
    started.mockReturnValueOnce(false).mockReturnValue(true);

    startWindowsHook(hook, {
      onStart: started,
      onStop: stopped,
      isAgentModeEnabled: () => true,
      getBinding: (intent) => (intent === 'dictation'
        ? { keyCode: null, modifiers: ['ctrl', 'win'] }
        : { keyCode: null, modifiers: ['alt', 'win'] }),
      getActivationMode: () => 'toggle',
    });

    // 1. Dictation toggle chord pressed but rejected
    key(hook, keys.leftControl, true);
    const consumed = key(hook, keys.leftWin, true);
    expect(consumed).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);

    // Release the chord
    key(hook, keys.leftWin, false);
    key(hook, keys.leftControl, false);

    // No stop should have been fired because session was never accepted
    expect(stopped).not.toHaveBeenCalled();

    // 2. Next press (now accepted) starts cleanly as a toggle
    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    expect(started).toHaveBeenCalledTimes(2);

    // Release chord keys
    key(hook, keys.leftWin, false);
    key(hook, keys.leftControl, false);

    // Subsequent press stops the active toggle session
    key(hook, keys.leftControl, true);
    key(hook, keys.leftWin, true);
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('does not create phantom agent session when agent onStart returns false', async () => {
    const hookModule = await importHook('agent-rejected-start');
    const hook = new hookModule.KeyboardHook();
    const started = mock(() => false);
    const stopped = mock();

    startWindowsHook(hook, {
      onStart: started,
      onStop: stopped,
      isAgentModeEnabled: () => true,
      getBinding: (intent) => (intent === 'dictation'
        ? { keyCode: null, modifiers: ['ctrl', 'win'] }
        : { keyCode: null, modifiers: ['alt', 'win'] }),
      getActivationMode: () => 'push-to-talk',
    });

    key(hook, keys.leftAlt, true);
    key(hook, keys.leftWin, true);
    expect(started).toHaveBeenCalledWith('agent');

    // On release of push-to-talk chord, stopped must not be called because start was rejected
    key(hook, keys.leftWin, false);
    key(hook, keys.leftAlt, false);
    expect(stopped).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== 'linux')('KeyboardHook Linux desktop shortcuts', () => {
  function createLinuxHarness(hookModule: HookModule, overrides?: Parameters<typeof createHarness>[1]): HookHarness {
    return createHarness(hookModule, overrides, (hook, options) => hook.start(options));
  }

  function fakeDesktop(kind: 'portal' | 'x11' = 'portal') {
    const desktop = {
      kind,
      bind: mock(async (bindings: Record<string, unknown>) =>
        Object.fromEntries(Object.keys(bindings).map((intent) => [intent, `${intent} chord`]))),
      keysHeld: mock(async (): Promise<boolean | null> => false),
      close: mock(),
      shortcut: (() => undefined) as ShortcutHandler,
      lose: (() => undefined) as () => void,
    };
    connectLinuxShortcuts.mockImplementationOnce(async ({ onShortcut, onLost }: { onShortcut: ShortcutHandler; onLost: () => void }) => {
      desktop.shortcut = onShortcut;
      desktop.lose = onLost;
      return desktop;
    });
    return desktop;
  }

  /** The next published status, skipping the replay of the current one on registration. */
  function nextStatus(hook: HookHarness['hook']) {
    return new Promise<unknown>((resolve) => {
      let replaying = true;
      hook.setLinuxShortcutStatusListener((status) => {
        if (replaying) return;
        hook.setLinuxShortcutStatusListener(null);
        resolve(status);
      });
      replaying = false;
    });
  }

  it('drives push-to-talk and toggle from desktop chord press/release, ignoring auto-repeat', async () => {
    const desktop = fakeDesktop();
    const { hook, started, stopped } = createLinuxHarness(await importHook('desktop-modes'), { agentMode: 'toggle' });
    await nextStatus(hook);

    desktop.shortcut('dictation', true, 1_000);
    desktop.shortcut('dictation', true);
    expect(started).toHaveBeenCalledTimes(1);
    // A desktop release can arrive without a timestamp even when the press had one.
    desktop.shortcut('dictation', false);
    expect(stopped.mock.calls).toEqual([[null]]);

    desktop.shortcut('agent', true);
    desktop.shortcut('agent', false);
    expect(started).toHaveBeenLastCalledWith('agent');
    expect(stopped).toHaveBeenCalledTimes(1);
    desktop.shortcut('agent', true);
    expect(stopped).toHaveBeenCalledTimes(2);
    hook.stop();
    expect(desktop.close).toHaveBeenCalled();
  });

  it('registers the Agent Mode chord only while Agent Mode is enabled and reports assigned triggers', async () => {
    const desktop = fakeDesktop();
    const harness = createLinuxHarness(await importHook('desktop-refresh'), { agentEnabled: false });
    expect(await nextStatus(harness.hook)).toEqual({ backend: 'portal', triggers: { dictation: 'dictation chord' } });

    harness.agentEnabled = true;
    const refreshed = nextStatus(harness.hook);
    harness.hook.refreshShortcuts();
    expect(await refreshed).toEqual({
      backend: 'portal',
      triggers: { dictation: 'dictation chord', agent: 'agent chord' },
    });
    expect(desktop.bind).toHaveBeenLastCalledWith({
      dictation: { keyCode: null, modifiers: ['ctrl', 'win'] },
      agent: { keyCode: null, modifiers: ['alt', 'win'] },
    });
    harness.hook.stop();
  });

  it('releases X11 grabs while paused so the chord reaches other apps', async () => {
    const desktop = fakeDesktop('x11');
    const { hook } = createLinuxHarness(await importHook('desktop-x11-pause'));
    await nextStatus(hook);
    const paused = nextStatus(hook);
    hook.setPaused(true);
    expect(await paused).toEqual({ backend: 'x11', triggers: {} });
    expect(desktop.bind).toHaveBeenLastCalledWith({});
    hook.stop();
  });

  it('waits for the desktop chord release before the final paste', async () => {
    const desktop = fakeDesktop();
    const { hook } = createLinuxHarness(await importHook('desktop-release-wait'), { dictationMode: 'toggle' });
    await nextStatus(hook);
    desktop.shortcut('dictation', true);
    const waiting = hook.waitForKeysReleased(new AbortController().signal);
    desktop.shortcut('dictation', false);
    expect(await waiting).toBe(true);
    hook.stop();
  });

  it('fails the final paste closed when key state is unknown or never answers', async () => {
    const desktop = fakeDesktop();
    const { hook } = createLinuxHarness(await importHook('desktop-release-unknown'));
    await nextStatus(hook);
    desktop.keysHeld.mockImplementationOnce(async () => null);
    expect(await hook.waitForKeysReleased(new AbortController().signal)).toBe(false);

    desktop.keysHeld.mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const waiting = hook.waitForKeysReleased(controller.signal);
    controller.abort();
    expect(await waiting).toBe(false);

    desktop.lose();
    expect(await hook.waitForKeysReleased(new AbortController().signal)).toBe(false);
    hook.stop();
  });

  it('ends a held push-to-talk recording when the desktop connection drops', async () => {
    const desktop = fakeDesktop();
    const { hook, stopped } = createLinuxHarness(await importHook('desktop-lost'));
    await nextStatus(hook);
    desktop.shortcut('dictation', true);
    const status = nextStatus(hook);
    desktop.lose();
    expect(stopped.mock.calls).toEqual([[null]]);
    expect(await status).toMatchObject({ backend: 'unavailable' });
    hook.stop();
  });

  it('reconnects to the desktop on the next shortcut change after the service drops', async () => {
    const lost = fakeDesktop();
    const { hook } = createLinuxHarness(await importHook('desktop-reconnect'));
    await nextStatus(hook);
    const unavailable = nextStatus(hook);
    lost.lose();
    await unavailable;
    const restored = fakeDesktop();
    const status = nextStatus(hook);
    hook.refreshShortcuts();
    expect(await status).toMatchObject({ backend: 'portal' });
    expect(restored.bind).toHaveBeenCalled();
    hook.stop();
  });

  it('falls back to evdev when the desktop has no shortcut API', async () => {
    startEvdevKeyboardReader.mockClear();
    const { hook, started, stopped } = createLinuxHarness(await importHook('desktop-fallback'));
    try {
      expect(await nextStatus(hook)).toEqual({ backend: 'evdev' });
      const onKey = startEvdevKeyboardReader.mock.calls[0]?.[0];
      if (!onKey) throw new Error('Expected evdev to receive a keyboard event handler');
      onKey(keys.leftControl, true, 1_000);
      onKey(keys.leftWin, true, 1_010);
      expect(started).toHaveBeenCalledWith('dictation');
      // Unplugging a keyboard releases its keys without a source timestamp.
      onKey(keys.leftWin, false);
      onKey(keys.leftControl, false);
      expect(stopped.mock.calls).toEqual([[null]]);
      // KDE best-effort paste waits on this; evdev has no portal backend but does see key release.
      expect(await hook.waitForShortcutDeactivation(new AbortController().signal, 0)).toBe(true);
    } finally {
      hook.stop();
    }
  });
});
