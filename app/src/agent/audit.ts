import { parseModelToolName } from '@shuddhalekhan/shared/mcp';
import { z } from 'zod';
import { COMPUTER_USE_SOURCE_ID } from '../shared/computer-use';
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


const toolListEventKeys = {
  tool_requests: 'toolCalls',
  tool_results: 'toolResults',
  tool_approval_requests: 'approvalRequests',
  tool_approval_responses_sent: 'approvalResponses',
};
const listItem = z.object({
  toolName: z.string().optional(), toolCallId: z.string().optional(), approvalId: z.string().optional(),
  toolCall: z.object({ toolName: z.string(), toolCallId: z.string().optional() }).optional(),
});

function isNative(modelName: string | undefined) {
  return modelName !== undefined && parseModelToolName(modelName).serverId === COMPUTER_USE_SOURCE_ID;
}


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

  forExecution(agentRunId: string, continuedFromComputerUse = false) {
    const nativeApprovals = new Set<string>();
    let executed = false;
    return {
      get usedComputerUse() { return executed; },
      markComputerUseExecuted() { executed = true; },
      record: (eventType: string, payload: AuditPayload = {}) => {
        const privateContent = executed || continuedFromComputerUse;
        switch (eventType) {
          case 'approval_requested':
          case 'approval_decision': {
            if (privateContent || payload.serverId === COMPUTER_USE_SOURCE_ID) {
              payload = { ...payload, arguments: undefined, message: undefined };
            }
            break;
          }
          case 'tool_requests':
          case 'tool_results':
          case 'tool_approval_requests':
          case 'tool_approval_responses_sent': {
            const key = toolListEventKeys[eventType];
            const items = payload[key];
            if (!Array.isArray(items)) return;
            payload = { [key]: items.map((item: unknown) => {
              const { data } = listItem.safeParse(item);
              if (!data) return {};
              const native = isNative(data.toolCall?.toolName ?? data.toolName);
              const { approvalId } = data;
              if (native && approvalId) nativeApprovals.add(approvalId);
              return privateContent || native || (approvalId !== undefined && nativeApprovals.has(approvalId)) ? data : item;
            }) };
            break;
          }
          case 'mcp_tool_execute_started':
          case 'mcp_tool_execute_result':
          case 'mcp_tool_execute_error':
            if (privateContent) {
              const { serverId, toolName, modelToolName, durationMs } = payload;
              payload = { serverId, toolName, modelToolName, durationMs };
            }
            break;
          case 'provider_warnings':
            if (privateContent) return;
            break;
          case 'run_failed':
            if (privateContent) payload = { error: 'The Agent run failed after Computer Use.' };
            break;
          case 'run_completed':
            if (privateContent) payload = { ...payload, response: undefined };
            break;
        }
        this.record(agentRunId, eventType, payload);
      },
    };
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
