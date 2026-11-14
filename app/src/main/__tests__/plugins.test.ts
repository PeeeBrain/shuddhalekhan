import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AppConfig, PluginInstallResult } from '../../types/ipc';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
installElectronMock();
const { registerPluginIpcHandlers } = await import('../plugins');
const { registerAgentContextIpcHandlers } = await import('../agent-context');

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} workflow\n---\n\nDo the ${name} thing.\n`;
function writeFiles(root: string, files: Record<string, unknown>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
}

describe('Plugins', () => {
  let directory: string;
  let agent: AppConfig['agent'];
  let failSave: boolean;
  const realFetch = globalThis.fetch;
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) as Promise<unknown>;
  const chooseFolder = (path: string) => electronMock.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
  const skillNames = () => readdirSync(join(directory, 'skills')).sort();

  beforeEach(() => {
    resetElectronMock();
    handlers.clear();
    electronMock.ipcMain.handle.mockImplementation((name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler));
    directory = mkdtempSync(join(tmpdir(), 'shuddha-plugins-'));
    failSave = false;
    agent = { enabled: true, provider: { baseUrl: '', model: '', apiKeyEnvVar: '' }, mcpServers: [], disabledSkills: [] };
    registerPluginIpcHandlers(directory, {
      getConfig: () => ({ agent }),
      setAgent: async next => {
        if (failSave) throw new Error('Provider settings contain an invalid value.');
        agent = next;
      },
    });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(directory, { recursive: true, force: true });
  });

  it('installs a plugin folder and removes exactly what it added', async () => {
    writeFiles(join(directory, 'skills'), { 'acme-notes/SKILL.md': skill('acme-notes') });
    const plugin = join(directory, 'acme-plugin');
    writeFiles(plugin, {
      '.claude-plugin/plugin.json': { name: 'acme', mcpServers: { 'acme-docs': { type: 'http', url: 'https://docs.acme.test/mcp' } } },
      '.mcp.json': { mcpServers: {
        acme: { type: 'http', url: 'https://mcp.acme.test/mcp' },
        local: { command: 'npx', args: ['acme-mcp'] },
        tokened: { type: 'http', url: 'https://api.acme.test/mcp', headers: { Authorization: 'Bearer ${ACME_TOKEN}' } },
      } },
      'skills/acme-triage/SKILL.md': skill('acme-triage'),
      'skills/acme-notes/SKILL.md': skill('acme-notes'),
      'commands/triage.md': 'Run triage.',
    });

    chooseFolder(plugin);
    const result = await invoke('plugins:install-folder') as PluginInstallResult;

    expect(result.plugin).toEqual({ name: 'acme', skills: ['acme-triage'], mcpServerIds: ['acme', 'acme-docs'] });
    expect(result.skipped).toHaveLength(4); // local program, token, user's same-named skill, coding-tool parts
    expect(agent.mcpServers.map(server => [server.id, server.enabled, server.transport])).toEqual([
      ['acme', true, { type: 'http', url: 'https://mcp.acme.test/mcp', redirect: 'error' }],
      ['acme-docs', true, { type: 'http', url: 'https://docs.acme.test/mcp', redirect: 'error' }],
    ]);
    expect(skillNames()).toEqual(['acme-notes', 'acme-triage']);

    await invoke('plugins:remove', 'acme');
    expect(agent.mcpServers).toEqual([]);
    expect(agent.plugins).toEqual([]);
    expect(skillNames()).toEqual(['acme-notes']);
    expect(readFileSync(join(directory, 'skills/acme-notes/SKILL.md'), 'utf8')).toBe(skill('acme-notes'));
  });

  it('keeps a skill the user recreated after removing the plugin copy', async () => {
    registerAgentContextIpcHandlers(directory, { getConfig: () => ({ agent }), setAgent: next => { agent = next; },
      getActiveAgentRunId: () => null, reply: () => undefined, publish: () => undefined });
    const plugin = join(directory, 'acme');
    writeFiles(plugin, { 'skills/acme-triage/SKILL.md': skill('acme-triage') });
    chooseFolder(plugin);
    await invoke('plugins:install-folder');
    await invoke('skills:remove', 'acme-triage');
    await invoke('skills:save', { name: 'acme-triage', content: skill('acme-triage'), create: true });

    await invoke('plugins:remove', 'acme');
    expect(skillNames()).toEqual(['acme-triage']);
  });

  it('installs a plugin whose server file points back at itself', async () => {
    const plugin = join(directory, 'loop');
    writeFiles(plugin, { '.claude-plugin/plugin.json': { mcpServers: './.mcp.json' }, '.mcp.json': '"./.mcp.json"',
      'skills/loop-notes/SKILL.md': skill('loop-notes') });
    chooseFolder(plugin);
    expect((await invoke('plugins:install-folder') as PluginInstallResult).plugin.skills).toEqual(['loop-notes']);
  });

  it('leaves no skills behind when saving the plugin fails', async () => {
    const plugin = join(directory, 'acme');
    writeFiles(plugin, { 'skills/acme-triage/SKILL.md': skill('acme-triage') });
    failSave = true;
    chooseFolder(plugin);
    await expect(invoke('plugins:install-folder')).rejects.toThrow('Provider settings contain an invalid value.');
    expect(existsSync(join(directory, 'skills/acme-triage'))).toBe(false);
    expect(agent.plugins).toBeUndefined();
  });

  it('lists GitHub plugins from the directory and installs one from its pinned subfolder', async () => {
    const sha = 'a'.repeat(40);
    const source = join(directory, 'tarball');
    writeFiles(join(source, `repo-${sha}`, 'plugin'), { '.mcp.json': { linear: { type: 'http', url: 'https://mcp.linear.test/mcp' } } });
    // Relative names keep Git for Windows' GNU tar from reading "C:" as a remote host.
    expect(spawnSync('tar', ['-czf', 'plugin.tgz', `repo-${sha}`], { cwd: source }).status).toBe(0);
    const requests: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      requests.push(String(url));
      if (String(url).endsWith('marketplace.json')) {
        return Response.json({ plugins: [
          { name: 'bundled', source: './plugins/bundled' },
          { name: 'linear', description: 'Issues', source: { source: 'git-subdir', url: 'https://github.com/acme/repo.git', path: 'plugin', ref: 'main', sha } },
          { name: 'elsewhere', source: { source: 'url', url: 'https://gitlab.com/acme/repo.git' } },
          { name: 'pyright-lsp', source: './plugins/pyright-lsp', lspServers: { pyright: {} } },
        ] });
      }
      return new Response(readFileSync(join(source, 'plugin.tgz')));
    }) as unknown as typeof fetch;

    expect((await invoke('plugins:catalog') as { name: string }[]).map(entry => entry.name)).toEqual(['bundled', 'linear']);
    const result = await invoke('plugins:install', 'linear') as PluginInstallResult;

    expect(requests.at(-1)).toBe(`https://codeload.github.com/acme/repo/tar.gz/${sha}`);
    expect(result.plugin).toEqual({ name: 'linear', skills: [], mcpServerIds: ['linear'] });
  });
});
