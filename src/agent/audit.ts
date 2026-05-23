import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { AGENT_AUDIT_SCHEMA_SQL, resolveAuditDbPath } from '../shared/audit-db';

type AuditPayload = Record<string, unknown>;
type SqliteStatement = {
  run(...args: unknown[]): unknown;
  finalize?(): unknown;
};
type SqliteDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): unknown;
};
type SqliteDatabaseConstructor = new (dbPath: string) => SqliteDatabase;

const SECRET_KEY_PATTERN = /(authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|auth[_-]?code|password|secret)/i;
const SECRET_VALUE_PATTERN = /\b(sk-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)\b/g;
const require = createRequire(import.meta.url);

export class AgentAuditStore {
  private readonly db: SqliteDatabase;
  private readonly insertEvent: SqliteStatement;
  private isClosed = false;

  constructor(dbPath = getDefaultAuditDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = createDatabase(dbPath);
    this.db.exec(AGENT_AUDIT_SCHEMA_SQL);
    this.insertEvent = this.db.prepare(
      'INSERT INTO agent_audit_events (agent_run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)'
    );
  }

  record(agentRunId: string, eventType: string, payload: AuditPayload = {}): void {
    if (this.isClosed) return;

    try {
      const sanitized = sanitizeAuditPayload(payload);
      this.insertEvent.run(agentRunId, eventType, JSON.stringify(sanitized), new Date().toISOString());
    } catch (err) {
      console.error('[agent-audit] failed to record audit event', eventType, err);
    }
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.insertEvent.finalize?.();
    this.db.close();
  }
}

function createDatabase(dbPath: string): SqliteDatabase {
  const Database = getDatabaseConstructor();
  return new Database(dbPath);
}

function getDatabaseConstructor(): SqliteDatabaseConstructor {
  if (isBunRuntime()) {
    return require('bun:sqlite').Database as SqliteDatabaseConstructor;
  }

  return require('better-sqlite3') as SqliteDatabaseConstructor;
}

function isBunRuntime(): boolean {
  return typeof process.versions.bun === 'string';
}

export function sanitizeAuditPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditPayload(item));
  }

  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : sanitizeAuditPayload(item);
    }
    return output;
  }

  if (typeof value === 'string') {
    return value.replace(SECRET_VALUE_PATTERN, '[redacted]');
  }

  return value;
}

function getDefaultAuditDbPath(): string {
  return resolveAuditDbPath(join(process.cwd(), '.shuddhalekhan'));
}
