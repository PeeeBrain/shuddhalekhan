import { describe, expect, it } from 'bun:test';
import type { PlatformCapabilities } from '../platform/types';

describe('PlatformCapabilities', () => {
  it('represents unsupported shortcut and paste states independently', () => {
    const capabilities: PlatformCapabilities = {
      platform: 'linux',
      desktop: 'gnome-wayland',
      shortcuts: {
        dictation: { state: 'needsSetup', message: 'Configure a desktop shortcut in GNOME Settings.' },
        agent: { state: 'unassigned', message: 'Agent Mode shortcut is not assigned.' },
      },
      textInjection: { state: 'unsupported', message: 'Paste simulation is not available in this session.' },
    };

    expect(capabilities.shortcuts.dictation.state).toBe('needsSetup');
    expect(capabilities.textInjection.state).toBe('unsupported');
  });
});
