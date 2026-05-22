import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { app } from 'electron';
import fs from 'fs';
import type { AuditRunSummary, AuditEventDetail } from '../types/ipc';

const INTERRUPTED_RUN_GRACE_MS = 5 * 60 * 1000;
const TERMINAL_EVENT_TYPES = new Set(['run_completed', 'run_failed', 'run_interrupted', 'run_cancelled', 'cancelled']);

function getAuditDbPath(): string {
  const baseDir =
    process.env.SHUDDHALEKHAN_AUDIT_DIR ||
    (process.env.APPDATA ? join(process.env.APPDATA, 'Shuddhalekhan') : join(app.getPath('userData')));
  return join(baseDir, 'agent-audit.sqlite');
}

let dbInstance: Database.Database | null = null;

function getDb(): Database.Database {
  if (!dbInstance) {
    const dbPath = getAuditDbPath();
    // Ensure the folder exists
    fs.mkdirSync(dirname(dbPath), { recursive: true });

    dbInstance = new Database(dbPath, { fileMustExist: false });
    
    // In case the DB file exists but table isn't created yet (e.g. settings window opened on fresh install)
    dbInstance.exec(`
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
    `);
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
    
    const events = eventsQuery.all(runIds.map(r => r.agent_run_id)) as {
      agent_run_id: string;
      event_type: string;
      payload_json: string;
      created_at: string;
    }[];
    
    // Group events by run ID
    const eventsByRunId = new Map<string, typeof events>();
    for (const event of events) {
      if (!eventsByRunId.has(event.agent_run_id)) {
        eventsByRunId.set(event.agent_run_id, []);
      }
      eventsByRunId.get(event.agent_run_id)!.push(event);
    }
    
    // 3. Process events chronologically for each run
    const summaries: AuditRunSummary[] = [];
    
    for (const run of runIds) {
      const runEvents = eventsByRunId.get(run.agent_run_id) || [];
      if (runEvents.length === 0) continue;
      
      const summary: AuditRunSummary = {
        agentRunId: run.agent_run_id,
        startedAt: runEvents[0].created_at,
        transcript: '',
        status: 'running',
        tools: [],
      };
      
      const toolsSet = new Set<string>();
      let latestEventAt = runEvents[0].created_at;
      let hasTerminalEvent = false;
      
      for (const event of runEvents) {
        latestEventAt = event.created_at;
        if (TERMINAL_EVENT_TYPES.has(event.event_type)) {
          hasTerminalEvent = true;
        }

        let payload: any = {};
        try {
          payload = JSON.parse(event.payload_json);
        } catch {
          // ignore parsing errors
        }
        
        switch (event.event_type) {
          case 'run_started':
            summary.transcript = payload.transcript || '';
            break;
          case 'run_completed':
            summary.status = 'completed';
            summary.response = payload.response;
            break;
          case 'run_failed':
            summary.status = 'failed';
            summary.error = payload.error;
            break;
          case 'run_interrupted':
            summary.status = 'interrupted';
            break;
          case 'run_cancelled':
          case 'cancelled':
            summary.status = 'cancelled';
            break;
          case 'approval_requested':
          case 'mcp_tool_execute_started':
            if (payload.serverId && payload.toolName) {
              toolsSet.add(`${payload.serverId}.${payload.toolName}`);
            }
            break;
          case 'tool_requests':
            if (Array.isArray(payload.toolCalls)) {
              for (const tc of payload.toolCalls) {
                if (tc && tc.toolName) {
                  const parts = tc.toolName.split('__');
                  if (parts.length > 1) {
                    toolsSet.add(`${parts[0]}.${parts.slice(1).join('__')}`);
                  } else {
                    toolsSet.add(tc.toolName);
                  }
                }
              }
            }
            break;
        }
      }
      
      if (!hasTerminalEvent && isStaleInterruptedRun(latestEventAt)) {
        summary.status = 'interrupted';
      }

      summary.tools = Array.from(toolsSet);
      summaries.push(summary);
    }
    
    return summaries;
  } catch (err) {
    console.error('Failed to query audit runs:', err);
    return [];
  }
}

function isStaleInterruptedRun(latestEventAt: string, now = Date.now()): boolean {
  const latestTime = new Date(latestEventAt).getTime();
  return Number.isFinite(latestTime) && now - latestTime > INTERRUPTED_RUN_GRACE_MS;
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
