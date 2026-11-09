import type { RecordingIntent, ShortcutBinding } from '../../types/ipc';
import { openGlobalShortcutsPortal } from './global-shortcuts-portal';
import { openX11Shortcuts } from './x11-shortcuts';
import { classifyDesktopSession } from '../dictation-delivery-policy';
import type { DesktopShortcutStatus } from '../../shared/desktop-status';

/**
 * Desktop-owned global shortcuts on Linux. The desktop delivers whole-chord
 * press/release per intent and keeps the chord away from the focused app,
 * unlike raw evdev, which only observes keys (and needs the `input` group).
 * A backend reports a release for every held chord before it tears down its
 * grabs or session, so push-to-talk never sticks across a rebind.
 */
export interface LinuxShortcutBackend {
  readonly kind: 'portal' | 'x11';
  /**
   * Replaces every registered chord. Resolves each intent to the trigger the
   * desktop actually assigned, or null when it refused (conflict, declined, or
   * left unassigned).
   */
  bind(bindings: LinuxShortcutBindings): Promise<LinuxShortcutTriggers>;
  /** True while any physical key is held; null when the desktop exposes no key state. */
  keysHeld(): Promise<boolean | null>;
  close(): void;
}

export type LinuxShortcutBindings = Partial<Record<RecordingIntent, ShortcutBinding>>;
export type LinuxShortcutTriggers = Extract<DesktopShortcutStatus, { backend: 'portal' | 'x11' }>['triggers'];
export type ShortcutEventHandler = (intent: RecordingIntent, isDown: boolean) => void;

export interface LinuxShortcutEvents {
  onShortcut: ShortcutEventHandler;
  /** Fires once if the desktop connection drops after opening (not after close()). */
  onLost: () => void;
  /** The desktop changed triggers, keyboard mappings or the session outside bind(). */
  onTriggers: (triggers: LinuxShortcutTriggers) => void;
}

/**
 * Wayland → xdg-desktop-portal GlobalShortcuts; X11 → passive key grabs.
 * Rejects when the session has neither, so the caller can fall back to evdev.
 */
export function connectLinuxShortcuts(events: LinuxShortcutEvents): Promise<LinuxShortcutBackend> {
  const session = classifyDesktopSession(process.platform, process.env);
  if (session === 'wayland' || session === 'kde-wayland') return openGlobalShortcutsPortal(events);
  if (session === 'x11') return openX11Shortcuts(events);
  return Promise.reject(new Error(`No desktop shortcut API for session type "${session ?? 'unknown'}".`));
}
