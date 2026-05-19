import { describe, expect, it, mock } from 'bun:test';
import { createShortcutTriggerController } from '../shortcuts/trigger-controller';

describe('createShortcutTriggerController', () => {
  it('maps hold press and release to begin and end', async () => {
    const begin = mock();
    const end = mock(async () => null);
    const controller = createShortcutTriggerController({
      recordingSession: { begin, end, isActive: () => false },
      onResult: mock(),
    });

    controller.handlePress({ action: 'dictation', triggerMode: 'hold' });
    await controller.handleRelease({ action: 'dictation', triggerMode: 'hold' });

    expect(begin).toHaveBeenCalledWith('dictation');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('maps toggle activation to begin when idle and end when active', async () => {
    let active = false;
    const begin = mock(() => { active = true; });
    const end = mock(async () => {
      active = false;
      return { text: 'done', intent: 'dictation' as const };
    });
    const onResult = mock();
    const controller = createShortcutTriggerController({
      recordingSession: { begin, end, isActive: () => active },
      onResult,
    });

    await controller.handleActivation({ action: 'dictation', triggerMode: 'toggle' });
    await controller.handleActivation({ action: 'dictation', triggerMode: 'toggle' });

    expect(begin).toHaveBeenCalledWith('dictation');
    expect(end).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ text: 'done', intent: 'dictation' });
  });
});
