import Database from 'better-sqlite3';
import { dirname } from 'path';
import { app } from 'electron';
import fs from 'fs';
import type { AuditRunSummary, AuditEventDetail } from '../types/ipc';
import { AGENT_AUDIT_SCHEMA_SQL, resolveAuditDbPath } from '../shared/audit-db';
import { summarizeAuditEvents, type AuditSummaryEventRow } from './audit-summary';

function getAuditDbPath(): string {
  return resolveAuditDbPath(app.getPath('userData'));
}

let dbInstance: Database.Database | null = null;

function getDb(): Database.Database {
  if (!dbInstance) {
    const dbPath = getAuditDbPath();
    // Ensure the folder exists
    fs.mkdirSync(dirname(dbPath), { recursive: true });

    dbInstance = new Database(dbPath, { fileMustExist: false });
    
    // In case the DB file exists but table isn't created yet (e.g. settings window opened on fresh install)
    dbInstance.exec(AGENT_AUDIT_SCHEMA_SQL);
  }
  return dbInstance;
}

export function getAuditRuns(): AuditRunSummary[] {
  try {
    const db = getDb();
    
    // 1. Get the latest 100 unique run IDs by their start time
    const runsQuery = db.prepare(`
      SELECT agent_run_id, MIN(created_at) as started_at 
      FROM agent_audit_events 
      GROUP BY agent_run_id 
      ORDER BY started_at DESC 
      LIMIT 100
    `);
    
    const runIds = runsQuery.all() as { agent_run_id: string; started_at: string }[];
    if (runIds.length === 0) return [];
    
    // 2. Fetch all events for these run IDs to reconstruct the summaries
    const placeholders = runIds.map(() => '?').join(',');
    const eventsQuery = db.prepare(`
      SELECT agent_run_id, event_type, payload_json, created_at 
      FROM agent_audit_events 
      WHERE agent_run_id IN (${placeholders}) 
      ORDER BY created_at ASC
    `);
    
    const events = eventsQuery.all(runIds.map(r => r.agent_run_id)) as AuditSummaryEventRow[];
    return summarizeAuditEvents(events);
  } catch (err) {
    console.error('Failed to query audit runs:', err);
    return [];
  }
}

export function getAuditRunDetail(agentRunId: string): AuditEventDetail[] {
  try {
    const db = getDb();
    const query = db.prepare(`
      SELECT id, agent_run_id, event_type, payload_json, created_at 
      FROM agent_audit_events 
      WHERE agent_run_id = ? 
      ORDER BY created_at ASC
    `);
    
    const rows = query.all(agentRunId) as {
      id: number;
      agent_run_id: string;
      event_type: string;
      payload_json: string;
      created_at: string;
    }[];
    
    return rows.map(row => {
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
    });
  } catch (err) {
    console.error(`Failed to query run detail for ${agentRunId}:`, err);
    return [];
  }
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
