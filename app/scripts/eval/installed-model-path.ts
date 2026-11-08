import { homedir } from 'os';
import { join } from 'path';

export function installedModelPath(modelDirectory: string): string {
  const appData = process.platform === 'win32'
    ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return process.env.SHUDDHALEKHAN_MODEL_DIR || join(appData, 'Shuddhalekhan', 'models', modelDirectory);
}
