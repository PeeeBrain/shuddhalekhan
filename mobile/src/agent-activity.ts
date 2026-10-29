import { z } from 'zod';

const identifier = z.string().min(1).max(100).regex(/^[a-zA-Z0-9-]+$/);
export const recoveredAgentRunSchema = z.object({
  runId: identifier,
  phase: z.enum(['running', 'awaitingApproval', 'completed', 'failed', 'cancelled', 'interrupted']),
  response: z.string().max(200_000),
});
export type RecoveredAgentRun = z.infer<typeof recoveredAgentRunSchema>;
export const startedAgentRunSchema = z.object({ runId: identifier });
export const stoppedAgentRunSchema = z.object({ runId: identifier });
export const agentApprovalActionSchema = z.object({ runId: identifier, approvalId: identifier, action: z.enum(['approve', 'deny', 'review']) });
export type AgentApprovalAction = z.infer<typeof agentApprovalActionSchema>;

type Update = { runId: string; status: string; completedSteps: number };
export type AgentActivityUpdate = Update & (
  | { phase: 'running' }
  | { phase: 'awaitingApproval'; approvalId: string; approvalTitle: string }
  | { phase: 'completed'; response: string }
  | { phase: 'failed' | 'cancelled' | 'interrupted' }
);

/** Native owns the activity and background grant; the controller owns the live agent and decisions. */
export type AgentActivityPort = {
  start(maximumSteps: number): Promise<{ runId: string }>;
  resume(runId: string): Promise<void>;
  prepareApproval(update: Extract<AgentActivityUpdate, { phase: 'awaitingApproval' }>): Promise<boolean>;
  takeApprovalAction(): Promise<AgentApprovalAction | null>;
  canContinueInBackground(runId: string): Promise<boolean>;
  update(update: AgentActivityUpdate): Promise<void>;
  recover(): Promise<RecoveredAgentRun | null>;
  clear(runId: string): Promise<void>;
};

/** Activity links navigate only. A link can never approve a tool. */
export function parseAgentActivityLink(value: string): { runId: string; approvalId: string | null } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'shuddhalekhan:' || url.hostname !== 'agent' || url.pathname || url.hash || url.username || url.password || url.port) return null;
    if (url.searchParams.getAll('runId').length !== 1 || url.searchParams.getAll('approvalId').length > 1) return null;
    const runId = identifier.safeParse(url.searchParams.get('runId'));
    const approvalId = url.searchParams.has('approvalId') ? identifier.safeParse(url.searchParams.get('approvalId')) : null;
    if (!runId.success || (approvalId && !approvalId.success)) return null;
    return { runId: runId.data, approvalId: approvalId?.data ?? null };
  } catch { return null; }
}
