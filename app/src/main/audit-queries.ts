import type { AuditEventDetail, AuditRunSummary } from '../types/ipc';
import { summarizeAuditEvents, type AuditSummaryEventRow } from './audit-summary';

type AuditReader = {
  prepare(sql: string): { all(...args: string[]): unknown[] };
};

export function queryAuditRuns(db: AuditReader): AuditRunSummary[] {
  const runs = db.prepare(`
    SELECT agent_run_id, MIN(created_at) as started_at
    FROM agent_audit_events GROUP BY agent_run_id ORDER BY started_at DESC LIMIT 100
  `).all() as { agent_run_id: string }[];
  if (!runs.length) return [];
  const events = db.prepare(`
    SELECT agent_run_id, event_type, payload_json, created_at FROM agent_audit_events
    WHERE agent_run_id IN (${runs.map(() => '?').join(',')}) ORDER BY created_at ASC
  `).all(...runs.map(run => run.agent_run_id)) as AuditSummaryEventRow[];
  return summarizeAuditEvents(events);
}

export function queryAuditRunDetail(db: AuditReader, agentRunId: string): AuditEventDetail[] {
  const rows = db.prepare(`
    SELECT id, agent_run_id, event_type, payload_json, created_at FROM agent_audit_events
    WHERE agent_run_id = ? ORDER BY created_at ASC
  `).all(agentRunId) as { id: number; agent_run_id: string; event_type: string; payload_json: string; created_at: string }[];
  return rows.map(row => {
    let payload = {};
    try { payload = JSON.parse(row.payload_json); } catch { /* Preserve malformed historical rows. */ }
    return { id: row.id, agentRunId: row.agent_run_id, eventType: row.event_type, payload, createdAt: row.created_at };
  });
}
