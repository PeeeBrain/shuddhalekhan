import type { PlatformProvider } from './types';

export function createMacosProvider(): PlatformProvider {
  return {
    getCapabilities: () => ({
      platform: 'darwin',
      desktop: 'macos',
      shortcuts: {
        dictation: { state: 'unassigned', message: 'Record a macOS shortcut in Settings.' },
        agent: { state: 'unassigned', message: 'Record a macOS shortcut in Settings.' },
      },
      textInjection: {
        state: 'needsSetup',
        message: 'macOS may require Accessibility permission before Shuddhalekhan can paste into other apps.',
      },
    }),
  };
}
