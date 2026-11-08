import type { RecordingIntent } from '../types/ipc';

export type DesktopShortcutStatus =
  | { backend: 'windows' | 'initializing' | 'evdev' }
  | { backend: 'portal' | 'x11'; triggers: Partial<Record<RecordingIntent, string | null>> }
  | { backend: 'unavailable'; error: string };

/** Opt-in KDE Wayland test mode; reported only in Wayland sessions. */
export interface WaylandInsertionStatus {
  state: 'unsupported' | 'off' | 'setting-up' | 'ready' | 'unavailable';
  message: string;
}

export interface DesktopStatus {
  shortcuts: DesktopShortcutStatus;
  delivery: { available: boolean; message: string };
  waylandInsertion?: WaylandInsertionStatus;
}
