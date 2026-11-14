import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../../types/ipc';
import type { AgentMemoryCommitResult, AgentMemorySnapshot, AgentSkillImport } from '../../shared/agent-context';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const chooseFolder = electronMock.dialog.showOpenDialog;
installElectronMock();
const { registerAgentContextIpcHandlers } = await import('../agent-context');

describe('Agent context IPC and run lifecycle', () => {
  let directory: string;
  let agent: AppConfig['agent'];
  let activeRun: string | null;
  let manager: ReturnType<typeof registerAgentContextIpcHandlers>;
  let replies: AgentMemoryCommitResult[];
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing ${channel}`);
    return handler({}, ...args);
  };
  const getMemory = () => invoke('memory:get') as AgentMemorySnapshot;
  beforeEach(() => {
    resetElectronMock();
    electronMock.ipcMain.handle.mockImplementation((name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler));
    directory = mkdtempSync(join(tmpdir(), 'shuddha-context-'));
    handlers.clear();
    replies = [];
    activeRun = 'run-1';
    agent = { enabled: true, memoryEnabled: true, provider: { baseUrl: '', model: '', apiKeyEnvVar: '' }, mcpServers: [] };
    manager = registerAgentContextIpcHandlers(directory, { getConfig: () => ({ agent }), setAgent: next => { agent = next; }, getActiveAgentRunId: () => activeRun,
      reply: (_run, _request, result) => replies.push(result), publish: () => undefined });
  });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it('saves facts for an active run and rejects a late proposal after a user clears memory', () => {
    const initial = manager.createRunContext().memory;
    if (!initial) throw new Error('Expected enabled memory.');
    const proposal = { type: 'memory:propose' as const, agentRunId: 'run-1', requestId: 'commit-1', revision: initial.revision, updates: [{ previous: null, text: 'The user prefers Marathi.' }] };
    manager.handleMemoryEvent(proposal);
    expect(replies[0]).toEqual({ saved: true });
    const runSnapshot = manager.createRunContext().memory;
    if (!runSnapshot) throw new Error('Expected enabled memory.');
    invoke('memory:clear', getMemory().revision);
    manager.handleMemoryEvent({ ...proposal, revision: runSnapshot.revision });
    expect(replies[1].saved).toBe(false);
    expect(getMemory().facts).toEqual([]);
    const beforeShutdown = getMemory();
    manager.invalidateMemory();
    manager.handleMemoryEvent({ ...proposal, revision: beforeShutdown.revision });
    expect(replies[2].saved).toBe(false);
  });

  it('rejects learning after disabling memory, replacing the run, or disabling Agent Mode', () => {
    const proposal = { type: 'memory:propose' as const, agentRunId: 'run-1', requestId: 'commit-1', revision: getMemory().revision, updates: [{ previous: null, text: 'The user prefers Marathi.' }] };
    agent.memoryEnabled = false;
    expect(manager.createRunContext().memory).toBeNull();
    manager.handleMemoryEvent(proposal);
    agent.memoryEnabled = true;
    activeRun = 'run-2';
    manager.handleMemoryEvent(proposal);
    activeRun = 'run-1';
    agent.enabled = false;
    manager.handleMemoryEvent(proposal);
    expect(replies.map(result => result.saved)).toEqual([false, false, false]);
    expect(getMemory().facts).toEqual([]);
  });

  it('does not replace the latest import preview when an older folder dialog finishes late', async () => {
    const older = join(directory, 'older-skill');
    const newer = join(directory, 'newer-skill');
    for (const [path, name] of [[older, 'older-skill'], [newer, 'newer-skill']]) {
      mkdirSync(path);
      writeFileSync(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: Format emails.\n---\nUse short paragraphs.\n`);
    }
    let finishOlder: (value: { canceled: boolean; filePaths: string[] }) => void = () => undefined;
    chooseFolder.mockReturnValueOnce(new Promise(resolve => { finishOlder = resolve; }));
    const first = invoke('skills:select-import');
    chooseFolder.mockResolvedValueOnce({ canceled: false, filePaths: [newer] });
    const latest = await invoke('skills:select-import');
    finishOlder({ canceled: false, filePaths: [older] });
    expect(await first).toBeNull();
    if (!latest || typeof latest !== 'object' || !('token' in latest)) throw new Error('Expected latest preview');
    expect(invoke('skills:import', latest.token)).toEqual([
      { name: 'newer-skill', description: 'Format emails.', enabled: false, error: null },
    ]);
  });

  it('imports a reviewed folder disabled, without requiring the sidecar, and preserves its source', async () => {
    agent.enabled = false;
    const source = join(directory, 'email-style');
    mkdirSync(source);
    const original = '---\nname: email-style\ndescription: Format emails.\n---\nUse short paragraphs.\n';
    writeFileSync(join(source, 'SKILL.md'), original);
    chooseFolder.mockResolvedValueOnce({ canceled: false, filePaths: [source] });
    const preview = await invoke('skills:select-import') as AgentSkillImport;
    expect(preview.name).toBe('email-style');
    expect(() => invoke('skills:import', 'wrong-token')).toThrow('Select');
    expect(invoke('skills:import', preview.token)).toEqual([{ name: 'email-style', description: 'Format emails.', enabled: false, error: null }]);
    expect(agent.disabledSkills).toEqual(['email-style']);
    invoke('skills:remove', 'email-style');
    expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toBe(original);
  });
});
