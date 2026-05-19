import type { PlatformProvider } from './types';

export function createWindowsProvider(): PlatformProvider {
  return {
    getCapabilities: () => ({
      platform: 'win32',
      desktop: 'windows',
      shortcuts: {
        dictation: { state: 'ready', message: 'Windows shortcut provider is available.' },
        agent: { state: 'ready', message: 'Windows shortcut provider is available.' },
      },
      textInjection: { state: 'ready', message: 'Windows paste simulation is available.' },
    }),
  };
}
