import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { Database } from 'bun:sqlite';

type AuditPayload = Record<string, unknown>;

const SECRET_KEY_PATTERN = /(authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|auth[_-]?code|password|secret)/i;
const SECRET_VALUE_PATTERN = /\b(sk-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)\b/g;

export class AgentAuditStore {
  private readonly db: Database;

  constructor(dbPath = getDefaultAuditDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_audit_events_run
        ON agent_audit_events(agent_run_id, created_at);
    `);
  }

  record(agentRunId: string, eventType: string, payload: AuditPayload = {}): void {
    const sanitized = sanitizeAuditPayload(payload);
    this.db
      .query(
        'INSERT INTO agent_audit_events (agent_run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(agentRunId, eventType, JSON.stringify(sanitized), new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
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
  const baseDir =
    process.env.SHUDDHALEKHAN_AUDIT_DIR ||
    (process.env.APPDATA ? join(process.env.APPDATA, 'Shuddhalekhan') : join(process.cwd(), '.shuddhalekhan'));

  return join(baseDir, 'agent-audit.sqlite');
}
