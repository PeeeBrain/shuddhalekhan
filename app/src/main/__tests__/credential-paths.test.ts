import { afterEach, describe, expect, it } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { applicationDefaultCredentialPaths } from '../transcription';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const originalEnvironment = { ...process.env };

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  for (const name of ['APPDATA', 'CLOUDSDK_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    if (originalEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnvironment[name];
  }
});

for (const platform of ['win32', 'linux']) {
  describe(`Google credential lookup on ${platform}`, () => {
    it('finds credentials in the platform default directory', () => {
      Object.defineProperty(process, 'platform', { value: platform });
      process.env.APPDATA = join('windows', 'roaming');
      delete process.env.CLOUDSDK_CONFIG;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      const base = platform === 'win32' ? process.env.APPDATA : join(homedir(), '.config');
      expect(applicationDefaultCredentialPaths()).toEqual([
        join(base, 'gcloud', 'application_default_credentials.json'),
      ]);
    });

    it('uses the configured gcloud directory after an explicit credential file', () => {
      Object.defineProperty(process, 'platform', { value: platform });
      process.env.GOOGLE_APPLICATION_CREDENTIALS = join('explicit', 'credentials.json');
      process.env.CLOUDSDK_CONFIG = join('custom', 'gcloud');
      expect(applicationDefaultCredentialPaths()).toEqual([
        process.env.GOOGLE_APPLICATION_CREDENTIALS,
        join(process.env.CLOUDSDK_CONFIG, 'application_default_credentials.json'),
      ]);
    });
  });
}
