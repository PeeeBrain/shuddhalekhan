import { describe, expect, it } from 'bun:test';
import type { ShortcutBinding } from '../../types/ipc';
import { validateShortcutBinding } from '../shortcuts/validation';

const bindings: Record<'dictation' | 'agent', ShortcutBinding> = {
  dictation: { action: 'dictation', accelerator: 'Control+Meta', triggerMode: 'hold', status: 'ready' },
  agent: { action: 'agent', accelerator: null, triggerMode: 'hold', status: 'unassigned' },
};

describe('validateShortcutBinding', () => {
  it('rejects shortcuts already used by another action', () => {
    expect(validateShortcutBinding(
      { action: 'agent', accelerator: 'Control+Meta', triggerMode: 'hold', status: 'unassigned' },
      bindings
    )).toEqual({
      ok: false,
      status: 'conflict',
      message: 'Already used by Dictation.',
    });
  });

  it('accepts available shortcuts', () => {
    expect(validateShortcutBinding(
      { action: 'agent', accelerator: 'Alt+Space', triggerMode: 'toggle', status: 'unassigned' },
      bindings
    )).toEqual({
      ok: true,
      status: 'ready',
    });
  });

  it('rejects shortcuts when the platform reports the action is not ready', () => {
    expect(validateShortcutBinding(
      { action: 'agent', accelerator: 'Alt+Space', triggerMode: 'toggle', status: 'unassigned' },
      bindings,
      {
        agent: { state: 'needsSetup', message: 'Configure the shortcut through GNOME Settings.' },
        dictation: { state: 'ready', message: 'Ready.' },
      }
    )).toEqual({
      ok: false,
      status: 'needsSetup',
      message: 'Configure the shortcut through GNOME Settings.',
    });
  });
});
