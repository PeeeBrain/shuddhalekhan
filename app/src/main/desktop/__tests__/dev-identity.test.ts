import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { prepareDevelopmentIdentity }: typeof import('../dev-identity') = await import(`../dev-identity?test=${Date.now()}`);

describe('development portal identity', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dictation-identity-test-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('makes the dev app discoverable and removes only its own file on shutdown', () => {
    const cleanup = prepareDevelopmentIdentity({ dataHome: dir, dataDirs: [], executable: '/app/electron', appPath: '/work/app' });
    const path = join(dir, 'applications', 'shuddhalekhan.desktop');
    expect(readFileSync(path, 'utf8')).toContain('Exec="/app/electron" "/work/app"');
    cleanup();
    expect(existsSync(path)).toBe(false);
  });

  it('preserves an installed identity and a replacement made while dev was running', () => {
    const options = { dataHome: dir, dataDirs: [], executable: '/app/electron', appPath: '/work/app' };
    const cleanup = prepareDevelopmentIdentity(options);
    const path = join(dir, 'applications', 'shuddhalekhan.desktop');
    const replacement = '[Desktop Entry]\nName=Installed app\n';
    writeFileSync(path, replacement);
    cleanup();
    prepareDevelopmentIdentity(options)();
    expect(readFileSync(path, 'utf8')).toBe(replacement);
  });

  it('uses the system installation without shadowing its launcher', () => {
    mkdirSync(join(dir, 'system', 'applications'), { recursive: true });
    writeFileSync(join(dir, 'system', 'applications', 'shuddhalekhan.desktop'), 'installed');
    prepareDevelopmentIdentity({ dataHome: join(dir, 'user'), dataDirs: [join(dir, 'system')], executable: '/electron', appPath: '/app' })();
    expect(existsSync(join(dir, 'user', 'applications', 'shuddhalekhan.desktop'))).toBe(false);
  });
});
