import type { AuditRunSummary } from '../types/ipc';

export interface AuditSummaryEventRow {
  agent_run_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
}

const INTERRUPTED_RUN_GRACE_MS = 5 * 60 * 1000;
const TERMINAL_EVENT_TYPES = new Set(['run_completed', 'run_failed', 'run_interrupted', 'run_cancelled', 'cancelled']);

export function summarizeAuditEvents(events: AuditSummaryEventRow[], now = Date.now()): AuditRunSummary[] {
  const eventsByRunId = new Map<string, AuditSummaryEventRow[]>();
  for (const event of events) {
    if (!eventsByRunId.has(event.agent_run_id)) {
      eventsByRunId.set(event.agent_run_id, []);
    }
    eventsByRunId.get(event.agent_run_id)!.push(event);
  }

  const summaries: AuditRunSummary[] = [];
  const runs = Array.from(eventsByRunId.entries()).sort(([, a], [, b]) => b[0].created_at.localeCompare(a[0].created_at));

  for (const [agentRunId, runEvents] of runs) {
    runEvents.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const firstEvent = runEvents[0];
    if (!firstEvent) continue;

    const summary: AuditRunSummary = {
      agentRunId,
      startedAt: firstEvent.created_at,
      transcript: '',
      status: 'running',
      tools: [],
    };

    const toolsSet = new Set<string>();
    let latestEventAt = firstEvent.created_at;
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

    if (!hasTerminalEvent && isStaleInterruptedRun(latestEventAt, now)) {
      summary.status = 'interrupted';
    }

    summary.tools = Array.from(toolsSet);
    summaries.push(summary);
  }

  return summaries;
}

function isStaleInterruptedRun(latestEventAt: string, now: number): boolean {
  const latestTime = new Date(latestEventAt).getTime();
  return Number.isFinite(latestTime) && now - latestTime > INTERRUPTED_RUN_GRACE_MS;
}
