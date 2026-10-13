import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { load, FAILSAFE_SCHEMA } from 'js-yaml';
import { z } from 'zod';
import type { AgentSkillDocument, AgentSkillSummary } from './agent-context';
import { writeAtomicFile } from './atomic-file';

export const SKILL_READ_LIMIT = 32768;
const IMPORT_BYTE_LIMIT = 10 * 1024 * 1024;
const skillNameSchema = z.string().min(1).max(64)
  .regex(/^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*$/u, 'Use a lowercase name with hyphens between words.')
  .refine(name => !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(name), 'This name is reserved by Windows.');
const frontmatterSchema = z.object({ name: skillNameSchema, description: z.string().trim().min(1).max(1024) });

export function parseSkill(content: string, name: string) {
  if (Buffer.byteLength(content) > SKILL_READ_LIMIT) throw new Error('Skill instructions exceed the 32 KiB limit.');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('Add YAML frontmatter with a name and description.');
  const metadata = frontmatterSchema.parse(load(match[1], { schema: FAILSAFE_SCHEMA, json: false }));
  if (metadata.name !== name) throw new Error('The skill name must match its folder name.');
  const instructions = content.slice(match[0].length).trim();
  if (!instructions) throw new Error('Add instructions below the frontmatter.');
  return { ...metadata, instructions };
}

/** Only app-owned descendants, with no junctions, symlinks, or Windows special paths. */
export function scopedSkillPath(directory: string, relativePath: string): string {
  if (isAbsolute(relativePath) || !relativePath || /[:\0]/.test(relativePath)) throw new Error('Use a relative path inside the skill folder.');
  const parts = relativePath.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) throw new Error('Invalid skill path.');
  let path = resolve(directory);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('The skills folder must not be a symbolic link.');
  for (const part of parts) {
    path = join(path, part);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Skill paths must not contain symbolic links or junctions.');
  }
  return path;
}

export function readSkillText(directory: string, relativePath: string): string {
  const path = scopedSkillPath(directory, relativePath);
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error('Select a text file inside the skill folder.');
  if (stat.size > SKILL_READ_LIMIT) throw new Error('This skill file exceeds the 32 KiB read limit.');
  const bytes = readFileSync(path);
  if (bytes.includes(0)) throw new Error('Binary skill resources cannot be read.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Skill resources must contain UTF-8 text.'); }
}

export function listSkills(directory: string, disabled: string[] = []): AgentSkillSummary[] {
  if (!existsSync(directory)) return [];
  scopedSkillPath(directory, 'SKILL.md');
  const entries = readdirSync(directory, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.'));
  if (entries.length > 256) throw new Error('The skills folder has too many entries. Keep at most 256 folders.');
  return entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => {
    try {
      const { description } = parseSkill(readSkillText(directory, `${entry.name}/SKILL.md`), entry.name);
      return { name: entry.name, description, enabled: !disabled.includes(entry.name), error: null };
    } catch (error) {
      return { name: entry.name, description: '', enabled: false, error: error instanceof Error ? error.message : 'Could not read this skill.' };
    }
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export class AgentSkillStore {
  constructor(readonly directory: string) {}

  read(name: string): AgentSkillDocument {
    skillNameSchema.parse(name);
    return { name, content: readSkillText(this.directory, `${name}/SKILL.md`) };
  }

  save(input: AgentSkillDocument & { create: boolean }): void {
    skillNameSchema.parse(input.name);
    parseSkill(input.content, input.name);
    const folder = scopedSkillPath(this.directory, input.name);
    const path = scopedSkillPath(this.directory, `${input.name}/SKILL.md`);
    mkdirSync(this.directory, { recursive: true });
    if (input.create) mkdirSync(folder); // Exclusive creation never overwrites a user's skill.
    else if (!existsSync(path)) throw new Error('This skill no longer exists. Refresh and try again.');
    try { writeAtomicFile(path, input.content); }
    catch (error) {
      if (input.create) rmSync(folder, { recursive: true, force: true });
      throw error;
    }
  }

  inspectImport(source: string): { name: string; description: string } {
    this.inspectFiles(source);
    const name = basename(source);
    const metadata = parseSkill(readSkillText(source, 'SKILL.md'), name);
    if (existsSync(scopedSkillPath(this.directory, name))) throw new Error('A skill with this name is already installed.');
    return { name, description: metadata.description };
  }

  import(source: string): string {
    const { name } = this.inspectImport(source);
    mkdirSync(this.directory, { recursive: true });
    const target = scopedSkillPath(this.directory, name);
    mkdirSync(target);
    try {
      // Copy SKILL.md last so runs never discover a partly imported skill.
      for (const entry of readdirSync(source).filter(entry => entry !== 'SKILL.md')) {
        cpSync(join(source, entry), join(target, entry), { recursive: true, force: false, errorOnExist: true, dereference: false });
      }
      this.inspectFiles(target);
      const content = readSkillText(source, 'SKILL.md');
      parseSkill(content, name);
      writeAtomicFile(scopedSkillPath(this.directory, `${name}/SKILL.md`), content);
    } catch (error) {
      rmSync(target, { recursive: true, force: true });
      throw error;
    }
    return name;
  }

  remove(name: string): void {
    if (/[\\/]/.test(name)) throw new Error('Select one installed skill folder.');
    const path = scopedSkillPath(this.directory, name);
    if (!lstatSync(path).isDirectory()) throw new Error('Select an installed skill folder.');
    rmSync(path, { recursive: true });
  }

  private inspectFiles(source: string): void {
    let bytes = 0;
    let count = 0;
    const visit = (path: string) => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Imported skills must not contain symbolic links or junctions.');
      if (++count > 512) throw new Error('A skill may contain at most 512 files and folders.');
      if (stat.isDirectory()) {
        for (const entry of readdirSync(path)) visit(scopedSkillPath(path, entry));
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > IMPORT_BYTE_LIMIT) throw new Error('The skill folder exceeds the 10 MiB import limit.');
      } else throw new Error('Imported skills must contain ordinary files and folders.');
    };
    visit(source);
  }
}
