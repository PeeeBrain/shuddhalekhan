import { app } from 'electron';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const STORE_DIRECTORY_NAME = 'Shuddhalekhan';
const MONOREPO_DEV_DIRECTORY = join('@shuddhalekhan', 'app');
const STORE_FILENAMES = [
  'shuddhalekhan-config.json',
  'shuddhalekhan-credentials.json',
] as const;

/**
 * Keep persistent settings independent of package.json's name. In unpackaged
 * Electron apps, userData otherwise changes when the package is moved or
 * renamed (for example to the scoped monorepo package @shuddhalekhan/app).
 */
export function getPersistentStoreDirectory(appDataDirectory = app.getPath('appData')): string {
  return join(appDataDirectory, STORE_DIRECTORY_NAME);
}

/**
 * Preserve settings created while monorepo dev builds used their package-name
 * derived userData directory. Existing files in the stable directory always
 * win so a default-filled dev store cannot overwrite an older real config.
 */
export function preparePersistentStoreDirectory(appDataDirectory = app.getPath('appData')): string {
  const targetDirectory = getPersistentStoreDirectory(appDataDirectory);
  const monorepoDevDirectory = join(appDataDirectory, MONOREPO_DEV_DIRECTORY);

  for (const filename of STORE_FILENAMES) {
    const source = join(monorepoDevDirectory, filename);
    const target = join(targetDirectory, filename);

    if (!existsSync(source) || existsSync(target)) continue;

    try {
      mkdirSync(targetDirectory, { recursive: true });
      copyFileSync(source, target);
    } catch {
      // A failed best-effort migration must not prevent the app from starting.
    }
  }

  return targetDirectory;
}
