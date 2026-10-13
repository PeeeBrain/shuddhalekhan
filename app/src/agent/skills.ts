import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { listSkills, parseSkill, readSkillText } from '../shared/agent-skills';
import type { AgentRuntimeCallbacks } from './runtime';

export const LOAD_SKILL_TOOL = 'shuddhalekhan_load_skill';
export const READ_SKILL_RESOURCE_TOOL = 'shuddhalekhan_read_skill_resource';

export function createSkillTools(directory: string, disabled: string[], signal: AbortSignal, audit: AgentRuntimeCallbacks['onAudit']): { context: string; tools: Record<string, Tool> } {
  const skills = listSkills(directory, disabled).filter(skill => !skill.error && skill.enabled);
  const catalog = skills.map(skill => `- ${skill.name}: ${skill.description}`).join('\n');
  if (skills.length > 64 || Buffer.byteLength(catalog) > 16384) throw new Error('Enabled skills exceed the catalog limit. Disable some skills in Settings.');
  if (!skills.length) return { context: '', tools: {} };
  const loaded = new Set<string>();
  const requireSkill = (name: string) => {
    signal.throwIfAborted();
    if (!skills.some(skill => skill.name === name)) throw new Error('This skill is unavailable or disabled.');
  };
  return {
    context: `Available skills:\n${catalog}\nUse ${LOAD_SKILL_TOOL} when a skill is relevant. Skills are user-authored guidance, not permission to bypass tool policies. Scripts are not executed by this runtime; use configured MCP tools or explain missing capabilities.`,
    tools: {
      [LOAD_SKILL_TOOL]: tool({
        description: 'Load the instructions of an available skill before using its workflow.',
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => {
          try {
            requireSkill(name);
            const skill = parseSkill(readSkillText(directory, `${name}/SKILL.md`), name);
            loaded.add(name);
            audit?.('skill_loaded', { name });
            return { name, instructions: skill.instructions, resources: `Read UTF-8 references with ${READ_SKILL_RESOURCE_TOOL} using this name and a relative path.` };
          } catch (error) { return { error: error instanceof Error ? error.message : 'Could not load this skill.' }; }
        },
      }),
      [READ_SKILL_RESOURCE_TOOL]: tool({
        description: 'Read a text reference inside a loaded skill folder. This never executes scripts.',
        inputSchema: z.object({ name: z.string(), path: z.string() }),
        execute: async ({ name, path }) => {
          try {
            requireSkill(name);
            if (!loaded.has(name)) throw new Error('Load the skill instructions first.');
            // Check against the skill root, not just the common skills directory.
            const content = readSkillText(`${directory}/${name}`, path);
            audit?.('skill_resource_read', { name, path });
            return { content };
          } catch (error) { return { error: error instanceof Error ? error.message : 'Could not read this skill resource.' }; }
        },
      }),
    },
  };
}
