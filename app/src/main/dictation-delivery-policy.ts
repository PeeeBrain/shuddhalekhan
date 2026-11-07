export function isWaylandSession(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): boolean {
  return platform === 'linux' && (environment.XDG_SESSION_TYPE === 'wayland' || Boolean(environment.WAYLAND_DISPLAY));
}

/** The best-effort test mode needs KWin's window-activation scripting; other compositors stay blocked. */
export function isKdeWaylandSession(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): boolean {
  return isWaylandSession(platform, environment) && /\bKDE\b/i.test(environment.XDG_CURRENT_DESKTOP ?? '');
}

/**
 * Portal keyboard injection cannot validate the original Wayland input context,
 * so Wayland stays blocked unless the user set up the KDE best-effort test mode.
 */
export function getAutomaticDeliveryError(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  waylandBestEffortReady = false,
): string | null {
  if (isWaylandSession(platform, environment)) {
    return waylandBestEffortReady ? null
      : 'Automatic insertion is unavailable on Wayland because the original input context cannot be verified. Copy the finished transcript from Last Transcript.';
  }
  if (platform === 'linux' && !environment.DISPLAY) return 'Automatic insertion requires a supported desktop session. Copy the finished transcript from Last Transcript.';
  if (platform !== 'win32' && platform !== 'linux') return 'Automatic insertion is not implemented on this operating system. Copy the finished transcript from Last Transcript.';
  return null;
}
