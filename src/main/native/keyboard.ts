import koffi from 'koffi';
import type { RecordingActivationMode, RecordingIntent, ShortcutBinding, ShortcutModifier } from '../../types/ipc';
import { modifierForKeyCode } from '../../shared/shortcut-keys';
import { DEFAULT_SHORTCUTS, normalizeBinding, SHORTCUT_MODIFIER_ORDER } from '../../shared/shortcut-bindings';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;

const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;

const KbdLlHookStructType = koffi.struct('KBDLLHOOKSTRUCT', {
  vkCode: 'uint32_t',
  scanCode: 'uint32_t',
  flags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t',
});

const SetWindowsHookEx = user32.func(
  'uintptr_t __stdcall SetWindowsHookExW(int32_t idHook, void * lpfn, uintptr_t hMod, uint32_t dwThreadId)'
);
const CallNextHookEx = user32.func(
  'intptr_t __stdcall CallNextHookEx(uintptr_t hhk, int32_t nCode, uintptr_t wParam, void * lParam)'
);
const UnhookWindowsHookEx = user32.func('bool __stdcall UnhookWindowsHookEx(uintptr_t hhk)');
const GetModuleHandle = kernel32.func('uintptr_t __stdcall GetModuleHandleW(const char16_t * lpModuleName)');

const callbackProto = koffi.proto('LowLevelKeyboardProc', 'intptr_t', ['int32_t', 'uintptr_t', koffi.pointer(KbdLlHookStructType)]);
type KoffiRegisteredCallback = ReturnType<typeof koffi.register>;

interface ActiveSession {
  intent: RecordingIntent;
  activationMode: RecordingActivationMode;
  /** Snapshot of the binding that started the session; immune to mid-session config changes. */
  binding: ShortcutBinding;
  /** Virtual-key code whose press completed the binding; its events are consumed. */
  triggerKeyCode: number;
}

export interface KeyboardHookStartOptions {
  onStart: (intent: RecordingIntent) => void;
  onStop: () => void;
  isAgentModeEnabled?: () => boolean;
  getBinding?: (intent: RecordingIntent) => ShortcutBinding | null;
  getActivationMode?: (intent: RecordingIntent) => RecordingActivationMode;
}

export class KeyboardHook {
  private hookHandle: number = 0;
  private callback: KoffiRegisteredCallback | null = null;
  private readonly pressed = new Set<number>();
  private session: ActiveSession | null = null;
  private toggleAwaitingRelease: ActiveSession | null = null;
  private paused = false;
  private captureSuspended = false;
  private onStartRecording: ((intent: RecordingIntent) => void) | null = null;
  private onStopRecording: (() => void) | null = null;
  private isAgentModeEnabled: () => boolean = () => false;
  private getBinding: (intent: RecordingIntent) => ShortcutBinding | null =
    (intent) => DEFAULT_SHORTCUTS[intent].binding;
  private getActivationMode: (intent: RecordingIntent) => RecordingActivationMode =
    () => 'push-to-talk';

  start(options: KeyboardHookStartOptions): void {
    this.onStartRecording = options.onStart;
    this.onStopRecording = options.onStop;
    this.isAgentModeEnabled = options.isAgentModeEnabled ?? (() => false);
    this.getBinding = options.getBinding ?? ((intent) => DEFAULT_SHORTCUTS[intent].binding);
    this.getActivationMode = options.getActivationMode ?? (() => 'push-to-talk');

    const proc = (nCode: number, wParam: bigint, lParam: unknown): bigint => {
      if (nCode >= 0) {
        const msg = Number(wParam);
        const isDown = msg === WM_KEYDOWN || msg === WM_SYSKEYDOWN;
        const isUp = msg === WM_KEYUP || msg === WM_SYSKEYUP;
        if (isDown || isUp) {
          const struct = koffi.decode(lParam, KbdLlHookStructType);
          const consumed = this.handleKey(struct.vkCode as number, isDown);
          if (consumed) return 1n;
        }
      }
      return CallNextHookEx(this.hookHandle, nCode, wParam, lParam);
    };

    this.callback = koffi.register(proc, koffi.pointer(callbackProto));
    const hModule = GetModuleHandle(undefined);
    this.hookHandle = SetWindowsHookEx(WH_KEYBOARD_LL, this.callback, hModule, 0);

    if (!this.hookHandle) {
      throw new Error('Failed to install keyboard hook');
    }
  }

  recordingEndedExternally(): void {
    if (this.session && !this.isBindingFullyReleased(this.session.binding)) {
      this.toggleAwaitingRelease = this.session;
    }
    this.session = null;
  }

  /** Pause prevents new sessions only; an active session keeps its completion semantics. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Inline capture temporarily suspends shortcut activation without consuming keys. */
  setCaptureSuspended(suspended: boolean): void {
    this.captureSuspended = suspended;
  }

  isCaptureSuspended(): boolean {
    return this.captureSuspended;
  }

  stop(): void {
    if (this.hookHandle) {
      UnhookWindowsHookEx(this.hookHandle);
      this.hookHandle = 0;
    }
    if (this.callback) {
      koffi.unregister(this.callback);
      this.callback = null;
    }
    this.pressed.clear();
    this.session = null;
    this.toggleAwaitingRelease = null;
  }

  /**
   * Core state machine. Returns true when the event belongs to a configured
   * trigger and must be consumed so it never reaches the focused application.
   */
  private handleKey(vkCode: number, isDown: boolean): boolean {
    const isRepeat = isDown && this.pressed.has(vkCode);
    if (!isRepeat) {
      if (isDown) this.pressed.add(vkCode);
      else this.pressed.delete(vkCode);
    }

    const modifiers = this.logicalModifiers();

    // A stopped toggle rearms only after every key of its binding is released.
    const awaiting = this.toggleAwaitingRelease;
    if (awaiting && this.isBindingFullyReleased(awaiting.binding)) {
      this.toggleAwaitingRelease = null;
    }

    const session = this.session;
    if (session) {
      if (session.activationMode === 'push-to-talk') {
        if (!isDown && !this.isBindingHeld(session.binding)) {
          if (!this.isBindingFullyReleased(session.binding)) {
            this.toggleAwaitingRelease = session;
          }
          this.session = null;
          this.onStopRecording?.();
        }
        return vkCode === session.triggerKeyCode;
      }

      if (
        isDown
        && !isRepeat
        && !this.toggleAwaitingRelease
        && this.completesBinding(vkCode, modifiers, session.binding)
      ) {
        this.toggleAwaitingRelease = session;
        this.session = null;
        this.onStopRecording?.();
        return true;
      }
      return vkCode === session.triggerKeyCode;
    }

    if (awaiting) {
      // Events belonging to the just-stopped trigger are consumed; new
      // sessions stay blocked until the binding is fully released.
      if (vkCode === awaiting.triggerKeyCode) return !this.captureSuspended;
      if (this.toggleAwaitingRelease) return false;
    }

    if (this.captureSuspended) return false;
    if (!isDown || isRepeat) return false;
    if (this.paused) return false;

    for (const intent of ['dictation', 'agent'] as const) {
      if (intent === 'agent' && !this.isAgentModeEnabled()) continue;
      const binding = this.getBinding(intent);
      if (!binding) continue;
      if (this.completesBinding(vkCode, modifiers, binding)) {
        const activationMode = this.getActivationMode(intent);
        this.session = {
          intent,
          activationMode,
          binding: normalizeBinding(binding),
          triggerKeyCode: vkCode,
        };
        if (activationMode === 'toggle') {
          this.toggleAwaitingRelease = this.session;
        }
        this.onStartRecording?.(intent);
        return true;
      }
    }

    // Reset stale Win key state if a non-modifier is pressed while Win is
    // logically stuck (e.g. the hook missed a release across an elevation
    // boundary).
    if (modifierForKeyCode(vkCode) === null && modifiers.has('win')) {
      this.pressed.delete(VK_LWIN);
      this.pressed.delete(VK_RWIN);
    }
    return false;
  }

  private logicalModifiers(): Set<ShortcutModifier> {
    const modifiers = new Set<ShortcutModifier>();
    for (const keyCode of this.pressed) {
      const modifier = modifierForKeyCode(keyCode);
      if (modifier) modifiers.add(modifier);
    }
    return modifiers;
  }

  private isModifierHeld(modifier: ShortcutModifier): boolean {
    for (const keyCode of this.pressed) {
      if (modifierForKeyCode(keyCode) === modifier) return true;
    }
    return false;
  }

  /** Every key of the binding is currently held (extra held keys are ignored). */
  private isBindingHeld(binding: ShortcutBinding): boolean {
    if (binding.keyCode !== null && !this.pressed.has(binding.keyCode)) return false;
    return binding.modifiers.every((modifier) => this.isModifierHeld(modifier));
  }

  /** No key of the binding remains pressed. */
  private isBindingFullyReleased(binding: ShortcutBinding): boolean {
    if (binding.keyCode !== null && this.pressed.has(binding.keyCode)) return false;
    return !binding.modifiers.some((modifier) => this.isModifierHeld(modifier));
  }

  private completesBinding(
    vkCode: number,
    modifiers: Set<ShortcutModifier>,
    binding: ShortcutBinding,
  ): boolean {
    const normalized = normalizeBinding(binding);
    if (!this.modifiersMatch(modifiers, normalized.modifiers)) return false;
    if (normalized.keyCode !== null) {
      return vkCode === normalized.keyCode;
    }
    return modifierForKeyCode(vkCode) !== null;
  }

  private modifiersMatch(
    held: Set<ShortcutModifier>,
    required: ShortcutModifier[],
  ): boolean {
    if (held.size !== required.length) return false;
    return required.every((modifier) => held.has(modifier));
  }

  handleKeyForTest(vkCode: number, isDown: boolean): boolean {
    return this.handleKey(vkCode, isDown);
  }
}

export const keyboardHook = new KeyboardHook();

export const keyboardTestKeyCodes = {
  leftShift: 0xa0,
  rightShift: 0xa1,
  leftControl: 0xa2,
  rightControl: 0xa3,
  leftAlt: 0xa4,
  rightAlt: 0xa5,
  leftWin: VK_LWIN,
  rightWin: VK_RWIN,
  letterA: 0x41,
};

export { SHORTCUT_MODIFIER_ORDER };
