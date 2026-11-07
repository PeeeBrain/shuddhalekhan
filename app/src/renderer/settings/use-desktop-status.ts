import { useEffect, useState } from 'react';
import type { RecordingIntent, ShortcutBinding } from '../../types/ipc';
import type { DesktopStatus } from '../../shared/desktop-status';
import { formatBinding } from '../../shared/shortcut-bindings';
import type { SettingsIpc } from './settings-ipc';

/** Main-owned shortcut and text-insertion status; `null` until the first answer. */
export function useDesktopStatus(settingsIpc: SettingsIpc): DesktopStatus | null {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  useEffect(() => {
    let pushed = false;
    const off = settingsIpc.onDesktopStatusChanged((next) => {
      pushed = true;
      setStatus(next);
    });
    // A push that lands first is newer than this reply.
    settingsIpc.getDesktopStatus().then((next) => pushed || setStatus(next), () => {
      if (!pushed) setStatus({ shortcuts: { backend: 'unavailable', error: 'Could not read the desktop shortcut status.' },
        delivery: { available: false, message: 'Could not determine text insertion support. Reopen Settings to try again.' } });
    });
    return () => { pushed = true; off?.(); };
  }, [settingsIpc]);
  return status;
}

export type ActiveTrigger =
  | { kind: 'active'; text: string }
  | { kind: 'checking' }
  | { kind: 'inactive'; message: string };

/**
 * What actually starts recording for `intent`. Portal and X11 report the trigger the
 * desktop assigned, which can differ from (or refuse) the saved binding.
 */
export function activeTrigger(
  status: DesktopStatus | null,
  intent: RecordingIntent,
  binding: ShortcutBinding | null,
): ActiveTrigger {
  const shortcuts = status?.shortcuts;
  if (!shortcuts || shortcuts.backend === 'initializing') return { kind: 'checking' };
  if (shortcuts?.backend === 'unavailable') return { kind: 'inactive', message: shortcuts.error };
  if (shortcuts?.backend === 'portal' || shortcuts?.backend === 'x11') {
    const assigned = shortcuts.triggers[intent];
    if (assigned) return { kind: 'active', text: assigned };
    if (!binding) return { kind: 'inactive', message: 'No shortcut assigned.' };
    return {
      kind: 'inactive',
      message: shortcuts.backend === 'portal'
        ? `Your desktop has not assigned ${formatBinding(binding)}. Choose one in your desktop's shortcut settings, or change it here.`
        : `${formatBinding(binding)} could not be registered. It may be unavailable in this layout or used by another app.`,
    };
  }
  if (!binding) return { kind: 'inactive', message: 'No shortcut assigned.' };
  return { kind: 'active', text: formatBinding(binding) };
}
