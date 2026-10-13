import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dialog, ipcMain, shell } from 'electron';
import { z } from 'zod';
import { AgentSkillStore, listSkills, scopedSkillPath } from '../shared/agent-skills';
import type { AgentMemoryCommitResult, AgentMemorySnapshot, AgentRunContext } from '../shared/agent-context';
import type { AppConfig } from '../types/ipc';
import { parseMemoryProposal, type SidecarEvent } from '../agent/protocol';
import { AgentMemoryStore } from './agent-memory';

type MemoryEvent = Extract<SidecarEvent, { type: 'memory:propose' | 'memory:status' }>;

export function registerAgentContextIpcHandlers(directory: string, deps: {
  getConfig: () => Pick<AppConfig, 'agent'>;
  setAgent: (agent: AppConfig['agent']) => void;
  getActiveAgentRunId: () => string | null;
  reply: (agentRunId: string, requestId: string, result: AgentMemoryCommitResult) => void;
  publish: (snapshot: AgentMemorySnapshot) => void;
}) {
  const skills = new AgentSkillStore(join(directory, 'skills'));
  const memory = new AgentMemoryStore(directory);
  let pendingImport: { token: string; path: string } | null = null;
  const list = () => listSkills(skills.directory, deps.getConfig().agent.disabledSkills ?? []);
  const publish = () => {
    const snapshot = memory.snapshot();
    deps.publish(snapshot);
    return snapshot;
  };
  ipcMain.handle('skills:list', list);
  ipcMain.handle('skills:read', (_event, name: unknown) => skills.read(z.string().parse(name)));
  ipcMain.handle('skills:save', (_event, input: unknown) => {
    skills.save(z.object({ name: z.string(), content: z.string(), create: z.boolean() }).parse(input));
    return list();
  });
  ipcMain.handle('skills:select-import', async () => {
    pendingImport = null;
    const selection = await dialog.showOpenDialog({ title: 'Import a skill folder', properties: ['openDirectory'] });
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return null;
    const preview = skills.inspectImport(path);
    pendingImport = { token: randomUUID(), path };
    return { token: pendingImport.token, ...preview };
  });
  ipcMain.handle('skills:import', (_event, token: unknown) => {
    if (!pendingImport || token !== pendingImport.token) throw new Error('Select the skill folder again before importing.');
    const source = pendingImport.path;
    pendingImport = null;
    // Disable before files become discoverable, including during the review step.
    const preview = skills.inspectImport(source);
    const agent = deps.getConfig().agent;
    deps.setAgent({ ...agent, disabledSkills: [...new Set([...(agent.disabledSkills ?? []), preview.name])] });
    skills.import(source);
    return list();
  });
  ipcMain.handle('skills:remove', (_event, name: unknown) => {
    skills.remove(z.string().parse(name));
    return list();
  });
  ipcMain.handle('skills:open-folder', async () => {
    scopedSkillPath(skills.directory, 'SKILL.md');
    mkdirSync(skills.directory, { recursive: true });
    const error = await shell.openPath(skills.directory);
    if (error) throw new Error('Could not open the skills folder.');
  });
  ipcMain.handle('memory:get', () => memory.snapshot());
  ipcMain.handle('memory:edit', (_event, revision: unknown, id: unknown, text: unknown) => {
    memory.edit(z.string().parse(revision), z.string().parse(id), z.string().parse(text));
    return publish();
  });
  ipcMain.handle('memory:remove', (_event, revision: unknown, id: unknown) => {
    memory.remove(z.string().parse(revision), z.string().parse(id));
    return publish();
  });
  ipcMain.handle('memory:clear', (_event, revision: unknown) => {
    memory.clear(z.string().parse(revision));
    return publish();
  });
  return {
    invalidateMemory: () => { memory.invalidate(); publish(); },
    createRunContext(): AgentRunContext {
      if (!deps.getConfig().agent.memoryEnabled) return { skillsDirectory: skills.directory, memory: null };
      const snapshot = memory.snapshot();
      if (snapshot.error && deps.getConfig().agent.memoryEnabled) publish();
      return { skillsDirectory: skills.directory, memory: deps.getConfig().agent.memoryEnabled && !snapshot.error
        ? { revision: snapshot.revision, markdown: snapshot.markdown } : null };
    },
    handleMemoryEvent(event: MemoryEvent): void {
      if (event.type === 'memory:status') {
        if (event.agentRunId === deps.getActiveAgentRunId() && deps.getConfig().agent.memoryEnabled) {
          memory.setStatus(event.status.slice(0, 600));
          publish();
        }
        return;
      }
      const parsed = parseMemoryProposal(event);
      const result: AgentMemoryCommitResult = !parsed.success ? { saved: false, message: 'Invalid memory update.' }
        : event.agentRunId !== deps.getActiveAgentRunId() || !deps.getConfig().agent.enabled || !deps.getConfig().agent.memoryEnabled
          ? { saved: false, message: 'Memory learning is disabled or this run is no longer active.' }
          : memory.commit(parsed.data.revision, parsed.data.updates);
      deps.reply(event.agentRunId, event.requestId, result);
      if (event.agentRunId === deps.getActiveAgentRunId() && deps.getConfig().agent.memoryEnabled) publish();
    },
  };
}
