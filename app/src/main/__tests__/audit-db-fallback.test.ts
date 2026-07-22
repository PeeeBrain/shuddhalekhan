import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';
import type { AuditRunSummary } from '../../types/ipc';

const spawnSync = mock();
const originalAppData = process.env.APPDATA;

mock.module('better-sqlite3', () => ({
  default: class BrokenDatabase {
    constructor() {
      throw new Error('native binding missing');
    }
  },
}));
mock.module('child_process', () => ({ spawnSync }));
installElectronMock();

describe('audit-db Bun fallback', () => {
  beforeEach(() => {
    resetElectronMock();
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming';
    electronMock.app.getPath.mockReturnValue('C:\\Users\\tester\\AppData\\Roaming\\Shuddhalekhan');
    electronMock.app.getAppPath.mockReturnValue('D:\\git_repos\\speech-2-text');
    electronMock.app.isPackaged = false;
    spawnSync.mockReset();
  });

  afterEach(() => {
    process.env.APPDATA = originalAppData;
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
        'bun.exe',
        [
          'D:\\git_repos\\speech-2-text\\src\\main\\audit-query-fallback.ts',
          JSON.stringify({
            mode: 'runs',
            dbPath: 'C:\\Users\\tester\\AppData\\Roaming\\Shuddhalekhan\\agent-audit.sqlite',
          }),
        ],
        expect.objectContaining({ encoding: 'utf8', windowsHide: true })
      );
    } finally {
      closeDb();
    }
  });
});
