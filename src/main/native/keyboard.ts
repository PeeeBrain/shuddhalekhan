import koffi from 'koffi';
import type { RecordingIntent, ShortcutBinding } from '../../types/ipc';

const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;
const WM_SYSKEYDOWN = 0x0104;

// Virtual key codes
const VK_LCONTROL = 0xA2;
const VK_RCONTROL = 0xA3;
const VK_LWIN = 0x5B;
const VK_RWIN = 0x5C;
const VK_LMENU = 0xA4;
const VK_RMENU = 0xA5;
const VK_SPACE = 0x20;

type KoffiRegisteredCallback = ReturnType<typeof koffi.register>;

interface KeyboardNativeApi {
  kbdLlHookStructType: any;
  callbackProto: any;
  setWindowsHookEx: (idHook: number, lpfn: unknown, hMod: number, dwThreadId: number) => number;
  callNextHookEx: (hhk: number, nCode: number, wParam: bigint, lParam: unknown) => bigint;
  unhookWindowsHookEx: (hhk: number) => boolean;
  getModuleHandle: (lpModuleName?: string) => number;
}

let nativeApi: KeyboardNativeApi | null = null;

interface ModifierState {
  ctrl: boolean;
  win: boolean;
  alt: boolean;
  recording: boolean;
  intent: RecordingIntent | null;
}

type ShortcutBindings = Record<RecordingIntent, ShortcutBinding>;

export class KeyboardHook {
  private hookHandle: number = 0;
  private callback: KoffiRegisteredCallback | null = null;
  private state: ModifierState = { ctrl: false, win: false, alt: false, recording: false, intent: null };
  private onStartRecording: ((intent: RecordingIntent) => void) | null = null;
  private onStopRecording: (() => void) | null = null;
  private isAgentModeEnabled: (() => boolean) = () => false;
  private getShortcuts: () => ShortcutBindings = defaultShortcuts;
  private pressedKeys = new Set<string>();

  start(
    onStart: (intent: RecordingIntent) => void,
    onStop: () => void,
    isAgentModeEnabled: () => boolean = () => false,
    getShortcuts: () => ShortcutBindings = defaultShortcuts
  ): void {
    this.onStartRecording = onStart;
    this.onStopRecording = onStop;
    this.isAgentModeEnabled = isAgentModeEnabled;
    this.getShortcuts = getShortcuts;

    if (process.platform !== 'win32') {
      console.warn('Global keyboard hook is not available on this platform yet.');
      return;
    }

    const api = getNativeKeyboardApi();

    const proc = (nCode: number, wParam: bigint, lParam: unknown): bigint => {
      if (nCode >= 0) {
        const msg = Number(wParam);
        const isDown = msg === WM_KEYDOWN || msg === WM_SYSKEYDOWN;
        const struct = koffi.decode(lParam, api.kbdLlHookStructType);
        this.handleKey(struct.vkCode as number, isDown);
      }
      return api.callNextHookEx(this.hookHandle, nCode, wParam, lParam);
    };

    this.callback = koffi.register(proc, koffi.pointer(api.callbackProto));
    const hModule = api.getModuleHandle(undefined);
    this.hookHandle = api.setWindowsHookEx(WH_KEYBOARD_LL, this.callback, hModule, 0);

    if (!this.hookHandle) {
      throw new Error('Failed to install keyboard hook');
    }
  }

  stop(): void {
    if (this.hookHandle) {
      getNativeKeyboardApi().unhookWindowsHookEx(this.hookHandle);
      this.hookHandle = 0;
    }
    if (this.callback) {
      koffi.unregister(this.callback);
      this.callback = null;
    }
    this.pressedKeys.clear();
  }

  private handleKey(vkCode: number, isDown: boolean): void {
    const isCtrl = vkCode === VK_LCONTROL || vkCode === VK_RCONTROL;
    const isWin = vkCode === VK_LWIN || vkCode === VK_RWIN;
    const isAlt = vkCode === VK_LMENU || vkCode === VK_RMENU;

    if (isCtrl) this.state.ctrl = isDown;
    if (isWin) this.state.win = isDown;
    if (isAlt) this.state.alt = isDown;

    const keyName = keyNameFromVk(vkCode);
    const wasPressed = keyName ? this.pressedKeys.has(keyName) : false;
    if (keyName) {
      if (isDown) {
        this.pressedKeys.add(keyName);
      } else {
        this.pressedKeys.delete(keyName);
      }
    }

    // Reset stale Win key state if non-modifier pressed while Win stuck
    if (isDown && !isCtrl && !isWin && !isAlt && !this.state.recording && this.state.win) {
      this.state.win = false;
      return;
    }

    if (this.state.recording) {
      // Stop conditions
      if (isDown && !wasPressed && this.state.intent) {
        const activeBinding = this.getShortcuts()[this.state.intent];
        if (activeBinding.triggerMode === 'toggle' && this.isBindingPressed(activeBinding)) {
          this.state.recording = false;
          this.state.intent = null;
          this.onStopRecording?.();
        }
      } else if (!isDown) {
        const activeBinding = this.state.intent ? this.getShortcuts()[this.state.intent] : null;
        const shouldStop = activeBinding?.triggerMode === 'hold' && activeBinding.accelerator
          ? !this.isBindingPressed(activeBinding)
          : false;

        if (shouldStop) {
          this.state.recording = false;
          this.state.intent = null;
          this.state.ctrl = false;
          this.state.win = false;
          this.state.alt = false;
          this.onStopRecording?.();
        }
      }
      return;
    }

    if (isDown) {
      this.tryStartFromBindings();
    }
  }

  private tryStartFromBindings(): void {
    const shortcuts = this.getShortcuts();
    for (const action of ['dictation', 'agent'] as const) {
      if (action === 'agent' && !this.isAgentModeEnabled()) continue;

      const binding = shortcuts[action];
      if (binding.status !== 'ready' || !binding.accelerator || !this.isBindingPressed(binding)) continue;

      if (binding.triggerMode === 'toggle') {
        this.onStartRecording?.(action);
        this.state.recording = true;
        this.state.intent = action;
        return;
      }

      this.state.recording = true;
      this.state.intent = action;
      this.onStartRecording?.(action);
      return;
    }
  }

  private isBindingPressed(binding: ShortcutBinding): boolean {
    const parts = parseAccelerator(binding.accelerator);
    if (parts.size === 0) return false;
    for (const part of parts) {
      if (!this.pressedKeys.has(part)) return false;
    }
    return this.pressedKeys.size === parts.size;
  }

  handleKeyForTest(vkCode: number, isDown: boolean): void {
    this.handleKey(vkCode, isDown);
  }
}

export const keyboardHook = new KeyboardHook();

export const keyboardTestKeyCodes = {
  leftControl: VK_LCONTROL,
  leftWin: VK_LWIN,
  leftAlt: VK_LMENU,
  space: VK_SPACE,
  letterA: 0x41,
};

function defaultShortcuts(): ShortcutBindings {
  return {
    dictation: { action: 'dictation', accelerator: 'Control+Meta', triggerMode: 'hold', status: 'ready' },
    agent: { action: 'agent', accelerator: 'Alt+Meta', triggerMode: 'hold', status: 'ready' },
  };
}

function keyNameFromVk(vkCode: number): string | null {
  if (vkCode === VK_LCONTROL || vkCode === VK_RCONTROL) return 'Control';
  if (vkCode === VK_LWIN || vkCode === VK_RWIN) return 'Meta';
  if (vkCode === VK_LMENU || vkCode === VK_RMENU) return 'Alt';
  if (vkCode === VK_SPACE) return 'Space';
  if (vkCode >= 0x41 && vkCode <= 0x5A) return String.fromCharCode(vkCode);
  return null;
}

function parseAccelerator(accelerator: string | null): Set<string> {
  return new Set((accelerator ?? '').split('+').map((part) => part.trim()).filter(Boolean));
}

function getNativeKeyboardApi(): KeyboardNativeApi {
  if (!nativeApi) {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const kbdLlHookStructType = koffi.struct('KBDLLHOOKSTRUCT', {
      vkCode: 'uint32_t',
      scanCode: 'uint32_t',
      flags: 'uint32_t',
      time: 'uint32_t',
      dwExtraInfo: 'uintptr_t',
    });
    const callbackProto = koffi.proto('LowLevelKeyboardProc', 'intptr_t', [
      'int32_t',
      'uintptr_t',
      koffi.pointer(kbdLlHookStructType),
    ]);

    nativeApi = {
      kbdLlHookStructType,
      callbackProto,
      setWindowsHookEx: user32.func(
        'uintptr_t __stdcall SetWindowsHookExW(int32_t idHook, void * lpfn, uintptr_t hMod, uint32_t dwThreadId)'
      ) as KeyboardNativeApi['setWindowsHookEx'],
      callNextHookEx: user32.func(
        'intptr_t __stdcall CallNextHookEx(uintptr_t hhk, int32_t nCode, uintptr_t wParam, void * lParam)'
      ) as KeyboardNativeApi['callNextHookEx'],
      unhookWindowsHookEx: user32.func('bool __stdcall UnhookWindowsHookEx(uintptr_t hhk)') as KeyboardNativeApi['unhookWindowsHookEx'],
      getModuleHandle: kernel32.func('uintptr_t __stdcall GetModuleHandleW(const char16_t * lpModuleName)') as KeyboardNativeApi['getModuleHandle'],
    };
  }

  return nativeApi;
}
