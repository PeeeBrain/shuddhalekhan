import koffi from 'koffi';
import type { RecordingIntent } from '../../types/ipc';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

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

interface ModifierState {
  ctrl: boolean;
  win: boolean;
  alt: boolean;
  recording: boolean;
  intent: RecordingIntent | null;
}

export class KeyboardHook {
  private hookHandle: number = 0;
  private callback: KoffiRegisteredCallback | null = null;
  private state: ModifierState = { ctrl: false, win: false, alt: false, recording: false, intent: null };
  private onStartRecording: ((intent: RecordingIntent) => void) | null = null;
  private onStopRecording: (() => void) | null = null;
  private isAgentModeEnabled: (() => boolean) = () => false;

  start(onStart: (intent: RecordingIntent) => void, onStop: () => void, isAgentModeEnabled: () => boolean = () => false): void {
    this.onStartRecording = onStart;
    this.onStopRecording = onStop;
    this.isAgentModeEnabled = isAgentModeEnabled;

    const proc = (nCode: number, wParam: bigint, lParam: unknown): bigint => {
      if (nCode >= 0) {
        const msg = Number(wParam);
        const isDown = msg === WM_KEYDOWN || msg === WM_SYSKEYDOWN;
        const struct = koffi.decode(lParam, KbdLlHookStructType);
        this.handleKey(struct.vkCode as number, isDown);
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

  stop(): void {
    if (this.hookHandle) {
      UnhookWindowsHookEx(this.hookHandle);
      this.hookHandle = 0;
    }
    if (this.callback) {
      koffi.unregister(this.callback);
      this.callback = null;
    }
  }

  private handleKey(vkCode: number, isDown: boolean): void {
    const isCtrl = vkCode === VK_LCONTROL || vkCode === VK_RCONTROL;
    const isWin = vkCode === VK_LWIN || vkCode === VK_RWIN;
    const isAlt = vkCode === VK_LMENU || vkCode === VK_RMENU;

    if (isCtrl) this.state.ctrl = isDown;
    if (isWin) this.state.win = isDown;
    if (isAlt) this.state.alt = isDown;

    // Reset stale Win key state if non-modifier pressed while Win stuck
    if (isDown && !isCtrl && !isWin && !isAlt && !this.state.recording && this.state.win) {
      this.state.win = false;
      return;
    }

    if (this.state.recording) {
      // Stop conditions
      if (!isDown) {
        let shouldStop = false;
        if (isCtrl && !this.state.ctrl) shouldStop = true;
        if (isWin && !this.state.win) shouldStop = true;
        if (this.state.intent === 'agent' && isAlt && !this.state.alt) shouldStop = true;

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

    // Start condition: Ctrl + Win (no Alt)
    if (isDown && this.state.ctrl && this.state.win && !this.state.alt) {
      this.state.recording = true;
      this.state.intent = 'dictation';
      this.onStartRecording?.('dictation');
      return;
    }

    // Start condition: Alt + Win (no Ctrl), gated by opt-in config.
    if (isDown && this.state.alt && this.state.win && !this.state.ctrl && this.isAgentModeEnabled()) {
      this.state.recording = true;
      this.state.intent = 'agent';
      this.onStartRecording?.('agent');
    }
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
  letterA: 0x41,
};
