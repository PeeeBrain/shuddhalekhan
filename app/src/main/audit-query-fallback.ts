import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { createRequire } from 'module';
import { AGENT_AUDIT_SCHEMA_SQL } from '../shared/audit-db';
import { summarizeAuditEvents, type AuditSummaryEventRow } from './audit-summary';

interface AuditQueryRequest {
  dbPath: string;
  mode: 'runs' | 'detail';
  agentRunId?: string;
}

type BunSqliteDatabase = {
  exec(sql: string): unknown;
  query(sql: string): {
    all(...args: unknown[]): unknown[];
  };
  close(): unknown;
};
type BunSqliteDatabaseConstructor = new (dbPath: string) => BunSqliteDatabase;

const require = createRequire(import.meta.url);
const { Database } = require('bun:sqlite') as { Database: BunSqliteDatabaseConstructor };
const request = JSON.parse(process.argv[2] || '{}') as AuditQueryRequest;

if (!request.dbPath || (request.mode !== 'runs' && request.mode !== 'detail')) {
  throw new Error('Invalid audit query fallback request');
}

mkdirSync(dirname(request.dbPath), { recursive: true });
const db = new Database(request.dbPath);

try {
  db.exec(AGENT_AUDIT_SCHEMA_SQL);

  if (request.mode === 'runs') {
    const runIds = db.query(`
      SELECT agent_run_id, MIN(created_at) as started_at
      FROM agent_audit_events
      GROUP BY agent_run_id
      ORDER BY started_at DESC
      LIMIT 100
    `).all() as { agent_run_id: string; started_at: string }[];

    if (runIds.length === 0) {
      console.log(JSON.stringify([]));
      process.exit(0);
    }

    const placeholders = runIds.map(() => '?').join(',');
    const events = db.query(`
      SELECT agent_run_id, event_type, payload_json, created_at
      FROM agent_audit_events
      WHERE agent_run_id IN (${placeholders})
      ORDER BY created_at ASC
    `).all(...runIds.map((run) => run.agent_run_id)) as AuditSummaryEventRow[];

    console.log(JSON.stringify(summarizeAuditEvents(events)));
    process.exit(0);
  }

  if (!request.agentRunId) {
    throw new Error('agentRunId is required for audit detail queries');
  }

  const rows = db.query(`
    SELECT id, agent_run_id, event_type, payload_json, created_at
    FROM agent_audit_events
    WHERE agent_run_id = ?
    ORDER BY created_at ASC
  `).all(request.agentRunId) as {
    id: number;
    agent_run_id: string;
    event_type: string;
    payload_json: string;
    created_at: string;
  }[];

  console.log(JSON.stringify(rows.map((row) => {
    let payload = {};
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      // ignore parsing errors
    }
    return {
      id: row.id,
      agentRunId: row.agent_run_id,
      eventType: row.event_type,
      payload,
      createdAt: row.created_at,
    };
  })));
} finally {
  db.close();
}
