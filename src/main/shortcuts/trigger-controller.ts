import type { RecordingResult } from '../recording-session';
import type { ShortcutTriggerEvent } from './types';

interface RecordingSessionPort {
  begin: (intent: ShortcutTriggerEvent['action']) => void;
  end: () => Promise<RecordingResult | null>;
  isActive: () => boolean;
}

interface ShortcutTriggerControllerDeps {
  recordingSession: RecordingSessionPort;
  onResult: (result: RecordingResult | null) => void | Promise<void>;
}

export function createShortcutTriggerController(deps: ShortcutTriggerControllerDeps) {
  async function finish() {
    const result = await deps.recordingSession.end();
    await deps.onResult(result);
  }

  return {
    handlePress(event: ShortcutTriggerEvent): void {
      if (event.triggerMode !== 'hold') return;
      deps.recordingSession.begin(event.action);
    },
    async handleRelease(event: ShortcutTriggerEvent): Promise<void> {
      if (event.triggerMode !== 'hold') return;
      await finish();
    },
    async handleActivation(event: ShortcutTriggerEvent): Promise<void> {
      if (event.triggerMode !== 'toggle') return;
      if (deps.recordingSession.isActive()) {
        await finish();
        return;
      }
      deps.recordingSession.begin(event.action);
    },
  };
}
