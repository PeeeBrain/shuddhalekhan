import { afterEach, describe, expect, it } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { installedModelPath } from '../eval/installed-model-path';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const originalEnvironment = { ...process.env };

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  for (const name of ['APPDATA', 'XDG_CONFIG_HOME', 'SHUDDHALEKHAN_MODEL_DIR']) {
    if (originalEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnvironment[name];
  }
});

for (const platform of ['win32', 'linux']) {
  describe(`installed model lookup on ${platform}`, () => {
    it('uses the platform config directory even when both environment variables are set', () => {
      Object.defineProperty(process, 'platform', { value: platform });
      delete process.env.SHUDDHALEKHAN_MODEL_DIR;
      process.env.APPDATA = join('windows', 'roaming');
      process.env.XDG_CONFIG_HOME = join('linux', 'config');
      const base = platform === 'win32' ? process.env.APPDATA : process.env.XDG_CONFIG_HOME;
      expect(installedModelPath('model-v1')).toBe(join(base, 'Shuddhalekhan', 'models', 'model-v1'));
    });

    it('falls back to the home directory instead of the current working directory', () => {
      Object.defineProperty(process, 'platform', { value: platform });
      delete process.env.SHUDDHALEKHAN_MODEL_DIR;
      delete process.env.APPDATA;
      delete process.env.XDG_CONFIG_HOME;
      const base = platform === 'win32' ? join(homedir(), 'AppData', 'Roaming') : join(homedir(), '.config');
      expect(installedModelPath('model-v1')).toBe(join(base, 'Shuddhalekhan', 'models', 'model-v1'));
    });

    it('keeps the explicit model directory override', () => {
      Object.defineProperty(process, 'platform', { value: platform });
      process.env.SHUDDHALEKHAN_MODEL_DIR = join('custom', 'model');
      expect(installedModelPath('model-v1')).toBe(process.env.SHUDDHALEKHAN_MODEL_DIR);
    });
  });
}
