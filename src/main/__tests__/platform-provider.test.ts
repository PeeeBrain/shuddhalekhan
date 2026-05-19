import { describe, expect, it } from 'bun:test';
import { createPlatformProviderForTest } from '../platform';

describe('createPlatformProvider', () => {
  it('selects Windows provider without changing the koffi implementation', () => {
    const provider = createPlatformProviderForTest('win32');
    expect(provider.getCapabilities().platform).toBe('win32');
    expect(provider.getCapabilities().shortcuts.dictation.state).toBe('ready');
  });

  it('selects macOS provider with explicit experimental capability states', () => {
    const provider = createPlatformProviderForTest('darwin');
    const capabilities = provider.getCapabilities();

    expect(capabilities.platform).toBe('darwin');
    expect(capabilities.shortcuts.dictation.state).toBe('unassigned');
  });

  it('selects Linux provider with GNOME Wayland setup status when relevant', () => {
    const provider = createPlatformProviderForTest('linux', { XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland' });
    const capabilities = provider.getCapabilities();

    expect(capabilities.platform).toBe('linux');
    expect(capabilities.desktop).toBe('gnome-wayland');
    expect(capabilities.shortcuts.dictation.state).toBe('needsSetup');
  });
});
