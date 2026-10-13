import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSkillStore, listSkills, readSkillText } from '../../agent-skills';

const document = (name: string) => `---\nname: ${name}\ndescription: >-\n  Follow a consistent email style.\nlicense: MIT\nmetadata:\n  author: Partha\n---\n\nUse concise paragraphs.\n`;

describe('standard local skills', () => {
  let directory: string;
  let store: AgentSkillStore;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'shuddha-skills-')); store = new AgentSkillStore(join(directory, 'skills')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it('creates, discovers, disables, edits, and removes a standard skill', () => {
    store.save({ name: 'email-style', content: document('email-style'), create: true });
    expect(listSkills(store.directory)).toEqual([{ name: 'email-style', description: 'Follow a consistent email style.', enabled: true, error: null }]);
    expect(listSkills(store.directory, ['email-style'])[0].enabled).toBe(false);
    const edited = store.read('email-style').content.replace('concise paragraphs', 'short sentences');
    store.save({ name: 'email-style', content: edited, create: false });
    expect(store.read('email-style').content).toContain('author: Partha');
    expect(store.read('email-style').content).toContain('short sentences');
    store.remove('email-style');
    expect(listSkills(store.directory)).toEqual([]);
  });

  it('imports references without overwriting an installed skill or changing the source', () => {
    const source = join(directory, 'email-style');
    mkdirSync(join(source, 'references'), { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), document('email-style'));
    writeFileSync(join(source, 'references', 'tone.md'), 'Use a friendly tone.');
    expect(store.inspectImport(source)).toEqual({ name: 'email-style', description: 'Follow a consistent email style.' });
    store.import(source);
    expect(readSkillText(join(store.directory, 'email-style'), 'references/tone.md')).toBe('Use a friendly tone.');
    expect(() => store.import(source)).toThrow('already installed');
    store.remove('email-style');
    expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toBe(document('email-style'));
  });

  it('shows invalid metadata without suppressing valid skills', () => {
    store.save({ name: 'email-style', content: document('email-style'), create: true });
    mkdirSync(join(store.directory, 'broken'));
    writeFileSync(join(store.directory, 'broken', 'SKILL.md'), 'no frontmatter');
    const skills = listSkills(store.directory);
    expect(skills.find(skill => skill.name === 'broken')).toMatchObject({ enabled: false, error: expect.stringContaining('frontmatter') });
    expect(skills.find(skill => skill.name === 'email-style')?.enabled).toBe(true);
  });

  it('rejects invalid creation and preserves existing documents on a failed edit', () => {
    store.save({ name: 'email-style', content: document('email-style'), create: true });
    expect(() => store.save({ name: 'email-style', content: document('other-name'), create: false })).toThrow('match');
    expect(() => store.save({ name: 'email-style', content: document('email-style'), create: true })).toThrow();
    expect(store.read('email-style').content).toBe(document('email-style'));
    expect(() => store.save({ name: '../escape', content: document('../escape'), create: true })).toThrow();
    expect(existsSync(join(directory, 'escape'))).toBe(false);
  });

  it('blocks traversal, absolute paths, alternate streams, and junction escapes', () => {
    store.save({ name: 'email-style', content: document('email-style'), create: true });
    const root = join(store.directory, 'email-style');
    const outside = join(directory, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.md'), 'private');
    symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const path of ['../outside/secret.md', '..\\outside\\secret.md', 'C:\\private\\secret.md', '\\\\host\\secret.md', 'SKILL.md:secret', 'linked/secret.md', '/private/secret.md']) {
      expect(() => readSkillText(root, path)).toThrow();
    }
    expect(() => store.inspectImport(root)).toThrow('symbolic');
    expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('private');
  });

  it('rejects oversized or binary reads without truncating instructions', () => {
    store.save({ name: 'email-style', content: document('email-style'), create: true });
    const root = join(store.directory, 'email-style');
    writeFileSync(join(root, 'big.md'), 'x'.repeat(32769));
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 255]));
    expect(() => readSkillText(root, 'big.md')).toThrow('32 KiB');
    expect(() => readSkillText(root, 'binary.bin')).toThrow('Binary');
  });
});
