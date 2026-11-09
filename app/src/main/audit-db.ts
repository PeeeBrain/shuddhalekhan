import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { app } from 'electron';
import fs from 'fs';
import type { AuditRunSummary, AuditEventDetail } from '../types/ipc';
import { AGENT_AUDIT_DB_FILENAME, AGENT_AUDIT_SCHEMA_SQL, resolveAuditDbPath } from '../shared/audit-db';
import { queryAuditRuns, queryAuditRunDetail } from './audit-queries';
import { getPersistentStoreDirectory } from './store-path';

const MONOREPO_AUDIT_MIGRATION_KEY = 'monorepo-audit-merged-v1';

function getAuditDbPath(): string {
  return resolveAuditDbPath(getPersistentStoreDirectory());
}

let dbInstance: Database.Database | null = null;
let preferBunAuditReader = false;

function getDb(): Database.Database {
  if (!dbInstance) {
    const dbPath = getAuditDbPath();
    // Ensure the folder exists
    fs.mkdirSync(dirname(dbPath), { recursive: true });

    dbInstance = new Database(dbPath, { fileMustExist: false });
    
    // In case the DB file exists but table isn't created yet (e.g. settings window opened on fresh install)
    dbInstance.exec(AGENT_AUDIT_SCHEMA_SQL);
    mergeMonorepoAuditDatabase(dbInstance, dbPath);
  }
  return dbInstance;
}

function mergeMonorepoAuditDatabase(db: Database.Database, targetPath: string): void {
  const migration = db
    .prepare('SELECT value FROM agent_audit_metadata WHERE key = ?')
    .get(MONOREPO_AUDIT_MIGRATION_KEY);
  if (migration) return;

  const legacyPath = join(app.getPath('appData'), '@shuddhalekhan', 'app', AGENT_AUDIT_DB_FILENAME);
  if (legacyPath === targetPath || !fs.existsSync(legacyPath)) {
    markAuditMigrationComplete(db);
    return;
  }

  let attached = false;
  try {
    db.prepare('ATTACH DATABASE ? AS monorepo_audit').run(legacyPath);
    attached = true;
    db.transaction(() => {
      db.exec(`
        INSERT INTO agent_audit_events (agent_run_id, event_type, payload_json, created_at)
        SELECT legacy.agent_run_id, legacy.event_type, legacy.payload_json, legacy.created_at
        FROM monorepo_audit.agent_audit_events AS legacy
        WHERE NOT EXISTS (
          SELECT 1
          FROM agent_audit_events AS current
          WHERE current.agent_run_id = legacy.agent_run_id
            AND current.event_type = legacy.event_type
            AND current.payload_json = legacy.payload_json
            AND current.created_at = legacy.created_at
        );
      `);
      markAuditMigrationComplete(db);
    })();
  } catch (error) {
    console.warn('Unable to merge the monorepo Agent History database:', error);
  } finally {
    if (attached) {
      try {
        db.exec('DETACH DATABASE monorepo_audit');
      } catch {
        // Leave the primary database usable even if SQLite cannot detach here.
      }
    }
  }
}

function markAuditMigrationComplete(db: Database.Database): void {
  db.prepare('INSERT OR REPLACE INTO agent_audit_metadata (key, value) VALUES (?, ?)')
    .run(MONOREPO_AUDIT_MIGRATION_KEY, new Date().toISOString());
}

export function getAuditRuns(): AuditRunSummary[] {
  try {
    if (preferBunAuditReader) {
      return queryAuditRunsWithBunFallback() ?? [];
    }

    return queryAuditRuns(getDb());
  } catch (err) {
    const fallbackRuns = queryAuditRunsWithBunFallback();
    if (fallbackRuns) {
      preferBunAuditReader = true;
      return fallbackRuns;
    }

    console.error('Failed to query audit runs:', err);
    return [];
  }
}

export function getAuditRunDetail(agentRunId: string): AuditEventDetail[] {
  try {
    if (preferBunAuditReader) {
      return queryAuditRunDetailWithBunFallback(agentRunId) ?? [];
    }

    return queryAuditRunDetail(getDb(), agentRunId);
  } catch (err) {
    const fallbackDetail = queryAuditRunDetailWithBunFallback(agentRunId);
    if (fallbackDetail) {
      preferBunAuditReader = true;
      return fallbackDetail;
    }

    console.error(`Failed to query run detail for ${agentRunId}:`, err);
    return [];
  }
}

function queryAuditRunsWithBunFallback(): AuditRunSummary[] | null {
  return runBunAuditQuery<AuditRunSummary[]>({ mode: 'runs', dbPath: getAuditDbPath() });
}

function queryAuditRunDetailWithBunFallback(agentRunId: string): AuditEventDetail[] | null {
  return runBunAuditQuery<AuditEventDetail[]>({ mode: 'detail', dbPath: getAuditDbPath(), agentRunId });
}

function runBunAuditQuery<T>(request: { dbPath: string; mode: 'runs' | 'detail'; agentRunId?: string }): T | null {
  if (app.isPackaged) return null;

  const scriptPath = join(app.getAppPath(), 'src', 'main', 'audit-query-fallback.ts');
  const result = spawnSync(getBunCommand(), [scriptPath, JSON.stringify(request)], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    return null;
  }

  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return null;
  }
}

function getBunCommand(): string {
  return process.platform === 'win32' ? 'bun.exe' : 'bun';
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  preferBunAuditReader = false;
}
