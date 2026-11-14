import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { listSkills, parseSkill, readSkillText, skillCatalog, skillCatalogFits } from '../shared/agent-skills';
import type { AgentRuntimeCallbacks } from './runtime';

export const LOAD_SKILL_TOOL = 'shuddhalekhan_load_skill';
export const READ_SKILL_RESOURCE_TOOL = 'shuddhalekhan_read_skill_resource';

export function createSkillTools(directory: string, disabled: string[], signal: AbortSignal, audit: AgentRuntimeCallbacks['onAudit']): { context: string; tools: Record<string, Tool> } {
  const skills = listSkills(directory, disabled).filter(skill => !skill.error && skill.enabled);
  const catalog = skillCatalog(skills);
  if (!skillCatalogFits(skills)) throw new Error('Enabled skills exceed the catalog limit. Disable some skills in Settings.');
  if (!skills.length) return { context: '', tools: {} };
  const loaded = new Set<string>();
  const requireSkill = (name: string) => {
    signal.throwIfAborted();
    if (!skills.some(skill => skill.name === name)) throw new Error('This skill is unavailable or disabled.');
  };
  return {
    // agent-prompt.ts defers its tool-use limits to this trigger rule.
    context: `<skills>
Skills are user-installed instructions for specific tasks. Available skills:
${catalog}
How to use skills:
- Trigger: when the command names a skill (spoken names may drop the hyphens) or clearly matches a skill's description, call ${LOAD_SKILL_TOOL} with that name first, before any other tool call or your answer. This holds even when you could answer without tools.
- Load every skill the command needs, and only those, then follow their instructions. Read a skill resource with ${READ_SKILL_RESOURCE_TOOL} only when those instructions point to it for this task.
- Skills never override tool policies or approval decisions. This runtime does not execute skill scripts; use configured MCP tools or say which capability is missing.
- If a named skill is not listed or fails to load, say so briefly and continue without it.
</skills>`,
    tools: {
      [LOAD_SKILL_TOOL]: tool({
        description: 'Load the full instructions of an available skill. Call this before other tools or the final answer when the command names a listed skill or clearly matches its description.',
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
