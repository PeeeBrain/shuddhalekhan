import koffi from 'koffi';
import type { RecordingActivationMode, RecordingIntent, ShortcutBinding, ShortcutModifier } from '../../types/ipc';
import { modifierForKeyCode } from '../../shared/shortcut-keys';
import { DEFAULT_SHORTCUTS, normalizeBinding, SHORTCUT_MODIFIER_ORDER } from '../../shared/shortcut-bindings';
import { startEvdevKeyboardReader } from './linux-input';
import {
  connectLinuxShortcuts,
  type LinuxShortcutBackend,
  type LinuxShortcutBindings,
  type LinuxShortcutTriggers,
} from '../desktop/linux-shortcuts';

/**
 * Which Linux activation path is live. `triggers` holds, per bound intent, the
 * chord the desktop actually assigned, or null when it refused (conflict,
 * declined, unassigned). evdev only observes keys, so its chords also reach
 * the focused app.
 */
export type LinuxShortcutStatus =
  | { backend: 'portal' | 'x11'; triggers: LinuxShortcutTriggers }
  | { backend: 'evdev' }
  | { backend: 'unavailable'; error: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const KbdLlHookStructType = koffi.struct('KBDLLHOOKSTRUCT', {
  vkCode: 'uint32_t',
  scanCode: 'uint32_t',
  flags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t',
});

const callbackProto = koffi.proto('LowLevelKeyboardProc', 'intptr_t', ['int32_t', 'uintptr_t', koffi.pointer(KbdLlHookStructType)]);

let win32Api: ReturnType<typeof loadWin32Api> | null = null;

/** Loaded on first use so importing this module never touches user32.dll off Windows. */
function loadWin32Api() {
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  return {
    SetWindowsHookEx: user32.func(
      'uintptr_t __stdcall SetWindowsHookExW(int32_t idHook, void * lpfn, uintptr_t hMod, uint32_t dwThreadId)'
    ),
    CallNextHookEx: user32.func(
      'intptr_t __stdcall CallNextHookEx(uintptr_t hhk, int32_t nCode, uintptr_t wParam, void * lParam)'
    ),
    UnhookWindowsHookEx: user32.func('bool __stdcall UnhookWindowsHookEx(uintptr_t hhk)'),
    GetModuleHandle: kernel32.func('uintptr_t __stdcall GetModuleHandleW(const char16_t * lpModuleName)'),
  };
}

function win32() {
  win32Api ??= loadWin32Api();
  return win32Api;
}

const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;

const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;

type KoffiRegisteredCallback = ReturnType<typeof koffi.register>;

interface ActiveSession {
  intent: RecordingIntent;
  activationMode: RecordingActivationMode;
  /** Snapshot of the binding that started the session; immune to mid-session config changes. */
  binding: ShortcutBinding;
}

export interface KeyboardHookStartOptions {
  onStart: (intent: RecordingIntent) => boolean | void;
  onStop: () => void;
  isAgentModeEnabled?: () => boolean;
  getBinding?: (intent: RecordingIntent) => ShortcutBinding | null;
  getActivationMode?: (intent: RecordingIntent) => RecordingActivationMode;
}

export class KeyboardHook {
  private hookHandle: number = 0;
  private callback: KoffiRegisteredCallback | null = null;
  private stopLinuxReader: (() => void) | null = null;
  private linuxBackend: LinuxShortcutBackend | null = null;
  /** Bumped by stop() so a slow desktop connection never revives a stopped hook. */
  private linuxGeneration = 0;
  private linuxSync: Promise<void> = Promise.resolve();
  private linuxConnecting = false;
  /** The desktop shortcut service dropped and has not come back yet. */
  private linuxLost = false;
  /** Automatic reconnects left; each may re-prompt on portal desktops, so they are few. */
  private linuxAutoReconnects = 3;
  private linuxReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private linuxStatus: LinuxShortcutStatus | null = null;
  private linuxStatusListener: ((status: LinuxShortcutStatus) => void) | null = null;
  /** Desktop-reported chords currently held (portal / X11 backends). */
  private readonly heldIntents = new Set<RecordingIntent>();
  private readonly pressed = new Set<number>();
  private readonly keyReleaseWaiters = new Set<(released: boolean) => void>();
  private session: ActiveSession | null = null;
  private toggleAwaitingRelease: ActiveSession | null = null;
  private paused = false;
  private captureSuspended = false;
  private onStartRecording: ((intent: RecordingIntent) => boolean | void) | null = null;
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

    if (process.platform === 'linux') {
      void this.startLinux(this.linuxGeneration);
      return;
    }

    const { SetWindowsHookEx, CallNextHookEx, GetModuleHandle } = win32();
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
    if (this.linuxBackend?.kind === 'x11') this.refreshShortcuts();
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Inline capture temporarily suspends shortcut activation without consuming keys. */
  setCaptureSuspended(suspended: boolean): void {
    this.captureSuspended = suspended;
    if (this.linuxBackend?.kind === 'x11') this.refreshShortcuts();
  }

  isCaptureSuspended(): boolean {
    return this.captureSuspended;
  }

  /**
   * Linux desktop shortcuts are registered with the desktop, so binding and
   * Agent Mode changes must be pushed: call after either changes. No-op on
   * Windows and evdev, which read bindings on every key. After the desktop
   * service dropped, this is also the user-driven reconnect.
   */
  refreshShortcuts(): void {
    if (this.linuxLost) return this.reconnectLinux();
    if (!this.linuxBackend) return;
    this.linuxSync = this.linuxSync.then(() => this.syncLinuxShortcuts());
  }

  /** Receives the current Linux activation status now (if known) and on every change. */
  setLinuxShortcutStatusListener(listener: ((status: LinuxShortcutStatus) => void) | null): void {
    this.linuxStatusListener = listener;
    if (listener && this.linuxStatus) listener(this.linuxStatus);
  }

  /** Final paste must not inherit the recording chord's physical modifiers. */
  waitForKeysReleased(signal: AbortSignal): Promise<boolean> {
    // With the desktop service gone, key state is unknown: fail closed.
    if (signal.aborted || this.linuxLost) return Promise.resolve(false);
    if (this.linuxBackend) return this.waitForDesktopRelease(this.linuxBackend, signal);
    if (this.pressed.size === 0) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = (released: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.keyReleaseWaiters.delete(finish);
        resolve(released);
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, 1000);
      this.keyReleaseWaiters.add(finish);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  /**
   * KDE Wayland best-effort test mode only. The portal reports chord
   * deactivation but not key state, so this waits (1 s deadline) until no chord
   * is held, then a fixed settle for trailing modifier releases. A modifier
   * still held after the settle can reach the paste; that is a disclosed
   * residual risk. Windows and X11 keep waitForKeysReleased.
   */
  async waitForShortcutDeactivation(signal: AbortSignal, settleMs = 250): Promise<boolean> {
    // The evdev fallback sees physical keys, so it can wait for real release.
    if (this.stopLinuxReader) return this.waitForKeysReleased(signal);
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const backend = this.linuxBackend;
    const deadline = Date.now() + 1000;
    while (this.heldIntents.size > 0) {
      if (signal.aborted || backend !== this.linuxBackend || Date.now() >= deadline) return false;
      await sleep(20);
    }
    await sleep(settleMs);
    return !signal.aborted && backend !== null && backend === this.linuxBackend && this.heldIntents.size === 0;
  }

  stop(): void {
    for (const finish of this.keyReleaseWaiters) finish(false);
    this.stopLinuxReader?.();
    this.stopLinuxReader = null;
    this.linuxGeneration += 1;
    this.linuxBackend?.close();
    this.linuxBackend = null;
    this.linuxSync = Promise.resolve();
    this.linuxConnecting = false;
    this.linuxLost = false;
    if (this.linuxReconnectTimer) clearTimeout(this.linuxReconnectTimer);
    this.linuxReconnectTimer = null;
    this.heldIntents.clear();
    if (this.hookHandle) {
      win32().UnhookWindowsHookEx(this.hookHandle);
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
   * Linux: desktop shortcuts (portal on Wayland, key grabs on X11), else raw
   * evdev for desktops without either. Only that fallback needs input-group
   * access. A reconnect skips the evdev fallback.
   */
  private async startLinux(generation: number, evdevFallback = true): Promise<void> {
    let desktopError: unknown;
    this.linuxConnecting = true;
    try {
      const backend = await connectLinuxShortcuts({
        onShortcut: (intent, isDown) => this.handleShortcut(intent, isDown),
        onLost: () => this.desktopShortcutsLost(),
        onTriggers: (triggers) => {
          const current = this.linuxBackend;
          if (current) this.publishLinuxStatus({ backend: current.kind, triggers });
        },
      });
      if (generation !== this.linuxGeneration) return backend.close();
      this.linuxLost = false;
      this.linuxBackend = backend;
      this.refreshShortcuts();
      return;
    } catch (error) {
      desktopError = error;
    } finally {
      if (generation === this.linuxGeneration) this.linuxConnecting = false;
    }
    if (generation !== this.linuxGeneration) return;
    if (!evdevFallback) return console.warn('Could not reconnect desktop shortcuts:', errorText(desktopError));
    try {
      // evdev observes keys but cannot consume them; triggers also reach the focused app.
      this.stopLinuxReader = startEvdevKeyboardReader((vkCode, isDown) => {
        this.handleKey(vkCode, isDown);
      });
      console.warn('Desktop shortcuts unavailable; reading keyboards through evdev:', errorText(desktopError));
      this.publishLinuxStatus({ backend: 'evdev' });
    } catch (error) {
      this.publishLinuxStatus({ backend: 'unavailable', error: `${errorText(desktopError)} ${errorText(error)}` });
    }
  }

  private async syncLinuxShortcuts(): Promise<void> {
    const backend = this.linuxBackend;
    if (!backend) return;
    const bindings: LinuxShortcutBindings = {};
    // Ungrabbed X11 chords reach apps while paused and reach the capture field
    // while capturing. Portal binds may prompt the user, so those stay bound
    // and handleShortcut ignores them instead.
    const idle = backend.kind === 'x11' && (this.paused || this.captureSuspended);
    for (const intent of ['dictation', 'agent'] as const) {
      if (idle || (intent === 'agent' && !this.isAgentModeEnabled())) continue;
      const binding = this.getBinding(intent);
      if (binding) bindings[intent] = normalizeBinding(binding);
    }
    let triggers: LinuxShortcutTriggers;
    try {
      triggers = await backend.bind(bindings);
    } catch (error) {
      console.error('Could not register desktop shortcuts:', error);
      triggers = Object.fromEntries(Object.keys(bindings).map((intent) => [intent, null]));
    }
    if (backend === this.linuxBackend) this.publishLinuxStatus({ backend: backend.kind, triggers });
  }

  private desktopShortcutsLost(): void {
    // A held chord's release can never arrive now; end push-to-talk instead of sticking.
    for (const intent of [...this.heldIntents]) this.handleShortcut(intent, false);
    this.linuxBackend = null;
    this.linuxLost = true;
    this.publishLinuxStatus({
      backend: 'unavailable',
      error: 'The desktop shortcut service disconnected. Shuddhalekhan reconnects when it returns or when shortcuts change.',
    });
    // shortcut: a few delayed retries cover a restarted portal; a crash-looping
    // one stops costing prompts after that and waits for the next shortcut change.
    if (this.linuxAutoReconnects <= 0) return;
    this.linuxAutoReconnects -= 1;
    const generation = this.linuxGeneration;
    this.linuxReconnectTimer = setTimeout(() => {
      this.linuxReconnectTimer = null;
      if (generation === this.linuxGeneration) this.reconnectLinux();
    }, 2000);
  }

  private reconnectLinux(): void {
    if (this.linuxConnecting) return;
    void this.startLinux(this.linuxGeneration, false);
  }

  private publishLinuxStatus(status: LinuxShortcutStatus): void {
    this.linuxStatus = status;
    this.linuxStatusListener?.(status);
  }

  /**
   * Polls until the chord and every key are up. Bounded by abort, a 1 s
   * deadline, and loss of the backend, even if a key-state query never answers.
   * Unknown key state (portal) fails closed.
   */
  private async waitForDesktopRelease(backend: LinuxShortcutBackend, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + 1000;
    const settle = <T>(promise: Promise<T>, fallback: T) => new Promise<T>((resolve) => {
      const done = (value: T) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve(value);
      };
      const abort = () => done(fallback);
      const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
      signal.addEventListener('abort', abort, { once: true });
      promise.then(done, () => done(fallback));
    });
    while (!signal.aborted && backend === this.linuxBackend && Date.now() < deadline) {
      if (this.heldIntents.size === 0) {
        const held = await settle(backend.keysHeld(), null);
        if (held === null) return false;
        if (!held) return !signal.aborted && backend === this.linuxBackend;
      }
      await settle(new Promise((resolve) => setTimeout(resolve, 20)), undefined);
    }
    return false;
  }

  /**
   * Desktop-delivered chord press/release. The desktop already matched the
   * chord and kept it from the focused app, so only intent semantics remain.
   */
  private handleShortcut(intent: RecordingIntent, isDown: boolean): void {
    if (!isDown) {
      if (!this.heldIntents.delete(intent)) return;
      if (this.session?.intent === intent && this.session.activationMode === 'push-to-talk') {
        this.session = null;
        this.onStopRecording?.();
      }
      return;
    }
    if (this.heldIntents.has(intent)) return; // auto-repeat
    this.heldIntents.add(intent);

    const session = this.session;
    if (session) {
      if (session.intent === intent && session.activationMode === 'toggle') {
        this.session = null;
        this.onStopRecording?.();
      }
      return;
    }
    if (this.paused || this.captureSuspended) return;
    if (intent === 'agent' && !this.isAgentModeEnabled()) return;
    const binding = this.getBinding(intent);
    if (!binding) return;
    if (this.onStartRecording && this.onStartRecording(intent) === false) return;
    this.session = { intent, activationMode: this.getActivationMode(intent), binding: normalizeBinding(binding) };
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
      if (this.pressed.size === 0) {
        for (const finish of this.keyReleaseWaiters) finish(true);
      }
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
        return this.shouldConsumeBindingKey(session.binding, vkCode);
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
      return this.shouldConsumeBindingKey(session.binding, vkCode);
    }

    if (awaiting) {
      // Events belonging to the just-stopped trigger are consumed; new
      // sessions stay blocked until the binding is fully released.
      if (this.shouldConsumeBindingKey(awaiting.binding, vkCode)) return !this.captureSuspended;
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
        const accepted = this.onStartRecording ? this.onStartRecording(intent) !== false : true;
        if (accepted) {
          const activationMode = this.getActivationMode(intent);
          this.session = {
            intent,
            activationMode,
            binding: normalizeBinding(binding),
          };
          if (activationMode === 'toggle') {
            this.toggleAwaitingRelease = this.session;
          }
        }
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

  private shouldConsumeBindingKey(binding: ShortcutBinding, keyCode: number): boolean {
    const modifier = modifierForKeyCode(keyCode);
    if (modifier !== null) return binding.modifiers.includes(modifier);
    return binding.keyCode === keyCode;
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
