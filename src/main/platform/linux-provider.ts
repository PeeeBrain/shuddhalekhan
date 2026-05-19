import type { PlatformProvider } from './types';

function detectLinuxDesktop(env: NodeJS.ProcessEnv): string {
  const desktop = (env.XDG_CURRENT_DESKTOP ?? '').toLowerCase();
  const session = (env.XDG_SESSION_TYPE ?? '').toLowerCase();

  if (desktop.includes('gnome') && session === 'wayland') return 'gnome-wayland';
  if (session === 'x11') return 'x11';
  if (session === 'wayland') return 'wayland-unverified';
  return 'linux-unknown';
}

export function createLinuxProvider(env: NodeJS.ProcessEnv = process.env): PlatformProvider {
  const desktop = detectLinuxDesktop(env);
  const shortcutState = desktop === 'gnome-wayland'
    ? { state: 'needsSetup' as const, message: 'Configure the shortcut through GNOME Settings.' }
    : { state: 'unsupported' as const, message: 'Shortcut support is unverified for this Linux desktop session.' };

  return {
    getCapabilities: () => ({
      platform: 'linux',
      desktop,
      shortcuts: {
        dictation: shortcutState,
        agent: shortcutState,
      },
      textInjection: {
        state: desktop === 'x11' ? 'needsSetup' : 'unsupported',
        message: desktop === 'x11'
          ? 'Paste simulation requires desktop validation on X11.'
          : 'Paste simulation is not verified for this Linux desktop session.',
      },
    }),
  };
}
