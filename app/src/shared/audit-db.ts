import { join } from 'path';

export const AGENT_AUDIT_DB_FILENAME = 'agent-audit.sqlite';

export const AGENT_AUDIT_SCHEMA_SQL = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS agent_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_audit_events_run
    ON agent_audit_events(agent_run_id, created_at);
`;

export function resolveAuditDbPath(fallbackBaseDir: string): string {
  const baseDir =
    process.env.SHUDDHALEKHAN_AUDIT_DIR ||
    (process.env.APPDATA ? join(process.env.APPDATA, 'Shuddhalekhan') : fallbackBaseDir);

  return join(baseDir, AGENT_AUDIT_DB_FILENAME);
}
