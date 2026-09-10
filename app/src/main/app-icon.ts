import { app, nativeImage } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Resolves the installed app icon for window chrome and the tray,
 * falling back to an inline mark when the packaged asset is missing.
 */
export function loadAppIcon(): Electron.NativeImage {
  const candidatePaths = app.isPackaged
    ? [
        join(process.resourcesPath, 'icons', 'tray-icon.ico'),
        join(app.getAppPath(), 'icons', 'tray-icon.ico'),
      ]
    : [
        join(app.getAppPath(), 'icons', 'tray-icon.ico'),
      ];

  for (const iconPath of candidatePaths) {
    if (!existsSync(iconPath)) continue;

    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      return icon;
    }
  }

  return nativeImage.createFromDataURL(
    'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
          <rect width="32" height="32" rx="8" fill="#141417"/>
          <path d="M10 16h12" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
          <path d="M16 8v16" stroke="#646cff" stroke-width="3" stroke-linecap="round"/>
        </svg>
      `)
  );
}
