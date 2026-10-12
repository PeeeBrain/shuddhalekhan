import type { AuditRunSummary } from '../../types/ipc';

export type StatusFilter = 'all' | AuditRunSummary['status'];

export const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All runs' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'running', label: 'Running' },
];

/** Case-insensitive match over the prompt, response, error and tool names. */
export function filterAuditRuns(runs: AuditRunSummary[], query: string, status: StatusFilter): AuditRunSummary[] {
  const needle = query.trim().toLowerCase();
  return runs.filter((run) =>
    (status === 'all' || run.status === status)
    && (!needle || [run.transcript, run.response ?? '', run.error ?? '', ...run.tools]
      .some((text) => text.toLowerCase().includes(needle))));
}

/** Provider errors arrive as "message | HTTP 403 | Response: {...}"; lead with the message. */
export function summarizeRunError(error: string): string {
  return error.split(' | ')[0].trim();
}
