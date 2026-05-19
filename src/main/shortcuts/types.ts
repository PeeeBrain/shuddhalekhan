import type { RecordingIntent, ShortcutTriggerMode } from '../../types/ipc';

export interface ShortcutTriggerEvent {
  action: RecordingIntent;
  triggerMode: ShortcutTriggerMode;
}
