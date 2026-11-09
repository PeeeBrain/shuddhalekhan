import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentAuditStore } from '../../agent/audit';
import type { AuditRunSummary } from '../../types/ipc';

const spawnSync = mock();
const originalAppData = process.env.APPDATA;
const originalAuditDir = process.env.SHUDDHALEKHAN_AUDIT_DIR;
const actualChildProcess = { ...await import('child_process') };
const actualSqlite = { ...await import('better-sqlite3') };

mock.module('better-sqlite3', () => ({
  default: class BrokenDatabase {
    constructor() {
      throw new Error('native binding missing');
    }
  },
}));
mock.module('child_process', () => ({ spawnSync }));
installElectronMock();

// Bun's mock.restore() does not undo mock.module replacements.
afterAll(() => {
  mock.module('child_process', () => actualChildProcess);
  mock.module('better-sqlite3', () => actualSqlite);
});

describe('audit-db Bun fallback', () => {
  let appData: string;
  beforeEach(() => {
    resetElectronMock();
    delete process.env.SHUDDHALEKHAN_AUDIT_DIR;
    appData = mkdtempSync(join(tmpdir(), 'audit-path-'));
    process.env.APPDATA = appData;
    electronMock.app.getPath.mockImplementation((name: string) =>
      name === 'appData' ? appData : join(appData, '@shuddhalekhan', 'app')
    );
    electronMock.app.getAppPath.mockReturnValue(join(import.meta.dir, '../../..'));
    electronMock.app.isPackaged = false;
    spawnSync.mockReset();
  });

  afterEach(() => {
    rmSync(appData, { recursive: true, force: true });
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (originalAuditDir === undefined) delete process.env.SHUDDHALEKHAN_AUDIT_DIR;
    else process.env.SHUDDHALEKHAN_AUDIT_DIR = originalAuditDir;
  });

  it('uses the Bun audit reader when the Electron better-sqlite3 binding is unavailable', async () => {
    const runs: AuditRunSummary[] = [
      {
        agentRunId: 'run-1',
        startedAt: '2026-06-25T10:00:00.000Z',
        transcript: 'hello',
        status: 'completed',
        response: 'done',
        tools: [],
      },
    ];
    spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify(runs), stderr: '' });

    const { getAuditRuns, closeDb } = await import(`../audit-db?fallback=${Date.now()}`);

    try {
      expect(getAuditRuns()).toEqual(runs);
      expect(spawnSync).toHaveBeenCalledWith(
        process.platform === 'win32' ? 'bun.exe' : 'bun',
        [
          join(electronMock.app.getAppPath(), 'src', 'main', 'audit-query-fallback.ts'),
          JSON.stringify({
            mode: 'runs',
            dbPath: join(appData, 'Shuddhalekhan', 'agent-audit.sqlite'),
          }),
        ],
        expect.objectContaining({ encoding: 'utf8', windowsHide: true })
      );
    } finally {
      closeDb();
    }
  });

  it('reads sidecar runs when Linux userData differs from the persistent store', async () => {
    delete process.env.APPDATA;

    // Match the environment supplied by agent-sidecar.ts, without leaking it to main.
    process.env.SHUDDHALEKHAN_AUDIT_DIR = join(appData, 'Shuddhalekhan');
    const store = new AgentAuditStore();
    store.record('linux-run', 'run_started', { transcript: 'hello from Linux' });
    store.record('linux-run', 'run_completed', {});
    store.close();
    delete process.env.SHUDDHALEKHAN_AUDIT_DIR;

    spawnSync.mockImplementation((command: string, args: string[]) => {
      const result = Bun.spawnSync([command, ...args]);
      return { status: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
    });
    const { getAuditRuns, getAuditRunDetail, closeDb }: typeof import('../audit-db') = await import(`../audit-db?linux=${Date.now()}`);
    try {
      expect(getAuditRuns().map(run => run.agentRunId)).toEqual(['linux-run']);
      expect(getAuditRunDetail('linux-run').map(event => event.eventType))
        .toEqual(['run_started', 'run_completed']);
    } finally {
      closeDb();
    }
  });
});
