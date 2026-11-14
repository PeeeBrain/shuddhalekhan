import { handle } from './typed-ipc';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { dialog } from 'electron';
import { z } from 'zod';
import { AgentSkillStore, scopedSkillPath } from '../shared/agent-skills';
import type { AppConfig, McpServerConfig, PluginInstallResult } from '../types/ipc';
import { extractTar } from './managed-local-model';

// Anthropic's official Claude plugin directory (Apache-2.0). Plugins use the Claude Code layout:
// .claude-plugin/plugin.json, skills/<name>/SKILL.md, and .mcp.json.
const CATALOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json';
const CATALOG_REPO = 'anthropics/claude-plugins-official';
const DOWNLOAD_LIMIT = 50 * 1024 * 1024;
const JSON_LIMIT = 1024 * 1024;

const pluginNameSchema = z.string().trim().min(1).max(64);
const catalogEntrySchema = z.object({
  name: pluginNameSchema,
  description: z.string().max(1024).catch(''),
  source: z.union([
    z.string().startsWith('./'),
    z.object({ url: z.string().optional(), repo: z.string().optional(), path: z.string().optional(), ref: z.string().optional(), sha: z.string().optional() }),
  ]),
  skills: z.array(z.string()).optional(),
  lspServers: z.unknown().optional(),
});
const manifestSchema = z.looseObject({
  name: pluginNameSchema.optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  mcpServers: z.unknown().optional(),
});

type CatalogEntry = { name: string; description: string; repo: string; ref: string; path: string; skills: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Manifest paths are written "./skills/x"; scopedSkillPath wants "skills/x" ("" is the plugin root). */
const cleanPath = (path: string) => path.replace(/^\.(?:\/|$)/, '').replace(/\/+$/, '');

/** Only GitHub sources are downloadable; LSP plugins are code-editor tooling. */
function toCatalogEntry(value: unknown): CatalogEntry | null {
  const parsed = catalogEntrySchema.safeParse(value);
  if (!parsed.success || parsed.data.lspServers) return null;
  const { name, description, source, skills = [] } = parsed.data;
  if (typeof source === 'string') return { name, description, repo: CATALOG_REPO, ref: 'main', path: cleanPath(source), skills };
  const repo = (source.repo ?? source.url)?.match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1];
  const ref = source.sha ?? source.ref ?? 'HEAD';
  if (!repo || !/^[\w./-]+$/.test(ref) || ref.includes('..')) return null;
  return { name, description, repo, ref, path: cleanPath(source.path ?? ''), skills };
}

async function loadCatalog(): Promise<CatalogEntry[]> {
  const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Could not load the plugin directory. Check your connection and try again.');
  const catalog = z.object({ plugins: z.array(z.unknown()) }).safeParse(await response.json().catch(() => null));
  if (!catalog.success) throw new Error('The plugin directory could not be read. Try again later.');
  return catalog.data.plugins.map(toCatalogEntry).filter(entry => entry !== null);
}

async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Could not download the plugin (HTTP ${response.status}).`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength;
    if (size > DOWNLOAD_LIMIT) {
      await reader.cancel();
      throw new Error('The plugin download is larger than 50 MB.');
    }
    chunks.push(chunk.value);
  }
  writeFileSync(path, Buffer.concat(chunks));
}

function readJson(directory: string, relativePath: string): unknown {
  const path = scopedSkillPath(directory, relativePath);
  if (!existsSync(path)) return undefined;
  if (!lstatSync(path).isFile() || lstatSync(path).size > JSON_LIMIT) throw new Error(`${relativePath} is not a valid plugin file.`);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${relativePath} is not valid JSON.`); }
}

/** Only remote https servers install as-is; anything needing local programs or secrets is reported back. */
function toServer(id: string, value: unknown): McpServerConfig | string {
  if (!isRecord(value)) return 'is not set up correctly';
  if (typeof value.command === 'string') return 'runs a program on your computer';
  if ((value.type !== undefined && value.type !== 'http' && value.type !== 'streamable-http') || typeof value.url !== 'string') {
    return 'uses a connection type Shuddhalekhan does not support';
  }
  if (value.headers || value.oauth || value.url.includes('${')) return 'needs a token or custom sign-in setup';
  if (!value.url.startsWith('https://') || !URL.canParse(value.url)) return 'is not a secure https link';
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,47}$/.test(id)) return 'has an unsupported name';
  return { id, displayName: id, enabled: true, transport: { type: 'http', url: value.url, redirect: 'error' }, discoveredTools: [], toolPolicies: {} };
}

function readPlugin(directory: string, extraSkillPaths: string[] = []) {
  const manifestJson = readJson(directory, '.claude-plugin/plugin.json') ?? readJson(directory, 'plugin.json') ?? {};
  const manifest = manifestSchema.safeParse(manifestJson);
  if (!manifest.success) throw new Error('plugin.json is not a valid plugin manifest.');
  const skipped: string[] = [];

  // Later sources win, as in Claude Code: .mcp.json, then the manifest's own mcpServers.
  const serverJson = new Map<string, unknown>();
  // Only the manifest may point at server files; the files themselves are read as-is, so they cannot loop.
  const addServers = (value: unknown, followPaths = false): void => {
    if (typeof value === 'string') {
      if (followPaths && value.endsWith('.json')) addServers(readJson(directory, cleanPath(value)));
      else skipped.push('a bundled connection package');
    } else if (Array.isArray(value)) value.forEach(item => addServers(item, followPaths));
    else if (isRecord(value)) {
      for (const [id, server] of Object.entries(isRecord(value.mcpServers) ? value.mcpServers : value)) serverJson.set(id, server);
    }
  };
  addServers(readJson(directory, '.mcp.json'));
  addServers(readJson(directory, 'mcp.json'));
  addServers(manifest.data.mcpServers, true);
  const servers: McpServerConfig[] = [];
  for (const [id, value] of serverJson) {
    const server = toServer(id, value);
    if (typeof server === 'string') skipped.push(`the ${id} connection (it ${server})`);
    else servers.push(server);
  }

  // A listed path is either one skill folder or a folder of skills.
  const skills = new Map<string, string>();
  for (const root of ['skills', ...[manifest.data.skills ?? []].flat(), ...extraSkillPaths].map(cleanPath)) {
    const path = root ? scopedSkillPath(directory, root) : directory;
    if (!existsSync(path) || !lstatSync(path).isDirectory()) continue;
    const folders = existsSync(join(path, 'SKILL.md')) ? [path] : readdirSync(path).map(entry => join(path, entry));
    for (const folder of folders) if (existsSync(join(folder, 'SKILL.md'))) skills.set(basename(folder), folder);
  }
  if (['commands', 'agents', 'hooks'].some(folder => existsSync(join(directory, folder)))) {
    skipped.push('parts made for coding tools (commands, subagents, hooks)');
  }
  return { name: manifest.data.name, servers, skills: [...skills.values()], skipped };
}

export function registerPluginIpcHandlers(directory: string, deps: {
  getConfig: () => Pick<AppConfig, 'agent'>;
  setAgent: (agent: AppConfig['agent']) => Promise<void>;
}) {
  const skills = new AgentSkillStore(join(directory, 'skills'));
  // Installs and removals read, then rewrite, the whole agent config; one at a time keeps them from losing each other's writes.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  async function install(source: string, catalogName?: string, extraSkillPaths?: string[]): Promise<PluginInstallResult> {
    const plugin = readPlugin(source, extraSkillPaths);
    const name = pluginNameSchema.parse(catalogName ?? plugin.name ?? basename(source).slice(0, 64));
    const agent = deps.getConfig().agent;
    const installed = agent.plugins ?? [];
    if (installed.some(item => item.name === name)) throw new Error(`${name} is already installed.`);
    const skipped = [...plugin.skipped];
    const servers = plugin.servers.filter(server => {
      const taken = agent.mcpServers.some(existing => existing.id === server.id);
      if (taken) skipped.push(`the ${server.id} connection (you already have one with that name)`);
      return !taken;
    });
    const sources = plugin.skills.filter(folder => {
      try {
        skills.inspectImport(folder);
        return true;
      } catch (error) {
        skipped.push(`the ${basename(folder)} skill (${errorMessage(error)})`);
        return false;
      }
    });
    if (!servers.length && !sources.length) {
      throw new Error(`Nothing in ${name} works in Shuddhalekhan yet${skipped.length ? `. Left out: ${skipped.join('; ')}.` : '.'}`);
    }
    const imported: string[] = [];
    try {
      for (const folder of sources) imported.push(skills.import(folder));
      const record = { name, skills: imported, mcpServerIds: servers.map(server => server.id) };
      await deps.setAgent({
        ...agent,
        mcpServers: [...agent.mcpServers, ...servers],
        disabledSkills: agent.disabledSkills?.filter(skill => !imported.includes(skill)),
        plugins: [...installed, record],
      });
      return { plugin: record, skipped };
    } catch (error) {
      for (const skill of imported) skills.remove(skill);
      throw error;
    }
  }

  handle('plugins:catalog', async () => (await loadCatalog()).map(({ name, description }) => ({ name, description })));
  handle('plugins:install', (_event, name: unknown) => serial(async () => {
    const entry = (await loadCatalog()).find(item => item.name === name);
    if (!entry) throw new Error('This plugin is no longer in the directory.');
    const staging = mkdtempSync(join(tmpdir(), 'shuddhalekhan-plugin-'));
    try {
      const archive = join(staging, 'plugin.tar.gz');
      const files = join(staging, 'files');
      await download(`https://codeload.github.com/${entry.repo}/tar.gz/${entry.ref}`, archive);
      mkdirSync(files);
      // Only the plugin's folder: the rest of a vendor's repo may hold links we refuse to extract.
      await extractTar(archive, files, entry.path ? [`*/${entry.path}/`] : []);
      const root = join(files, readdirSync(files)[0] ?? '');
      return await install(entry.path ? scopedSkillPath(root, entry.path) : root, entry.name, entry.skills);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }));
  handle('plugins:install-folder', async () => {
    const selection = await dialog.showOpenDialog({ title: 'Choose a plugin folder', properties: ['openDirectory'] });
    const folder = selection.filePaths[0];
    if (selection.canceled || !folder) return null;
    return serial(() => install(folder));
  });
  handle('plugins:remove', (_event, name: unknown) => serial(async () => {
    const agent = deps.getConfig().agent;
    const plugin = agent.plugins?.find(item => item.name === name);
    if (!plugin) return;
    // Config first: a run never sees a plugin whose files are half gone.
    await deps.setAgent({
      ...agent,
      mcpServers: agent.mcpServers.filter(server => !plugin.mcpServerIds.includes(server.id)),
      disabledSkills: agent.disabledSkills?.filter(skill => !plugin.skills.includes(skill)),
      plugins: agent.plugins?.filter(item => item !== plugin),
    });
    for (const skill of plugin.skills) if (existsSync(join(skills.directory, skill))) skills.remove(skill);
  }));
}
