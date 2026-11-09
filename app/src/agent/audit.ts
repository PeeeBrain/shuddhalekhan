import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { openAuditDatabase } from '../shared/audit-sqlite';
import { SECRET_KEY_PATTERN, redactAgentSecrets } from '../shared/agent-secrets';
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


export class AgentAuditStore {
  private readonly db: SqliteDatabase;
  private readonly insertEvent: SqliteStatement;
  private readonly lastStatusByRunId = new Map<string, string>();
  private isClosed = false;

  constructor(dbPath = resolveAuditDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openAuditDatabase(dbPath);
    this.db.exec(AGENT_AUDIT_SCHEMA_SQL);
    this.insertEvent = this.db.prepare(
      'INSERT INTO agent_audit_events (agent_run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)'
    );
  }

  record(agentRunId: string, eventType: string, payload: AuditPayload = {}): void {
    if (this.isClosed) return;

    try {
      const sanitized = sanitizeAuditPayload(payload);
      const payloadJson = JSON.stringify(sanitized);
      if (eventType === 'status') {
        const previousStatus = this.lastStatusByRunId.get(agentRunId);
        if (previousStatus === payloadJson) return;
        this.lastStatusByRunId.set(agentRunId, payloadJson);
      }
      if (['run_completed', 'run_failed', 'run_interrupted'].includes(eventType)) {
        this.lastStatusByRunId.delete(agentRunId);
      }

      this.insertEvent.run(agentRunId, eventType, payloadJson, new Date().toISOString());
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
    return redactAgentSecrets(value);
  }

  return value;
}
