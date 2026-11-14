import { describe, expect, it } from 'bun:test';
import { summarizeAuditEvents } from '../audit-summary';

describe('summarizeAuditEvents', () => {
  it('summarizes terminal and running audit runs without losing final response, tools, approvals, or errors', () => {
    const summaries = summarizeAuditEvents(
      [
        { agent_run_id: 'run-completed', event_type: 'run_started', payload_json: JSON.stringify({ transcript: 'Summarize this' }), created_at: '2026-06-25T10:00:00.000Z' },
        { agent_run_id: 'run-completed', event_type: 'approval_requested', payload_json: JSON.stringify({ serverId: 'files', toolName: 'write' }), created_at: '2026-06-25T10:00:01.000Z' },
        { agent_run_id: 'run-completed', event_type: 'tool_requests', payload_json: JSON.stringify({ toolCalls: [{ toolName: 'shell__grep' }] }), created_at: '2026-06-25T10:00:02.000Z' },
        { agent_run_id: 'run-completed', event_type: 'run_completed', payload_json: JSON.stringify({ response: 'Done' }), created_at: '2026-06-25T10:00:03.000Z' },
        { agent_run_id: 'run-failed', event_type: 'run_started', payload_json: JSON.stringify({ transcript: 'Break' }), created_at: '2026-06-25T09:00:00.000Z' },
        { agent_run_id: 'run-failed', event_type: 'run_failed', payload_json: JSON.stringify({ error: 'Boom' }), created_at: '2026-06-25T09:00:01.000Z' },
        { agent_run_id: 'run-interrupted', event_type: 'run_started', payload_json: JSON.stringify({ transcript: 'Stop' }), created_at: '2026-06-25T08:00:00.000Z' },
        { agent_run_id: 'run-interrupted', event_type: 'run_interrupted', payload_json: JSON.stringify({ reason: 'shutdown' }), created_at: '2026-06-25T08:00:01.000Z' },
        // Older versions wrote run_cancelled; existing audit databases still hold it.
        { agent_run_id: 'run-cancelled', event_type: 'run_started', payload_json: JSON.stringify({ transcript: 'Cancel' }), created_at: '2026-06-25T07:00:00.000Z' },
        { agent_run_id: 'run-cancelled', event_type: 'run_cancelled', payload_json: JSON.stringify({ reason: 'user' }), created_at: '2026-06-25T07:00:01.000Z' },
        { agent_run_id: 'run-active', event_type: 'run_started', payload_json: JSON.stringify({ transcript: 'Still running' }), created_at: '2026-06-25T11:00:00.000Z' },
      ],
      Date.parse('2026-06-25T11:01:00.000Z')
    );

    expect(summaries.find((run) => run.agentRunId === 'run-completed')).toMatchObject({
      status: 'completed',
      transcript: 'Summarize this',
      response: 'Done',
      tools: ['files.write', 'shell.grep'],
    });
    expect(summaries.find((run) => run.agentRunId === 'run-failed')).toMatchObject({ status: 'failed', error: 'Boom' });
    expect(summaries.find((run) => run.agentRunId === 'run-interrupted')).toMatchObject({ status: 'interrupted' });
    expect(summaries.find((run) => run.agentRunId === 'run-cancelled')).toMatchObject({ status: 'cancelled' });
    expect(summaries.find((run) => run.agentRunId === 'run-active')).toMatchObject({ status: 'running' });
  });

  it('keeps a reply in the run it answers: named by the first command, status from the latest reply', () => {
    const [summary] = summarizeAuditEvents(
      [
        { agent_run_id: 'run-1', event_type: 'run_started', payload_json: JSON.stringify({ transcript: 'Weather?' }), created_at: '2026-06-25T10:00:00.000Z' },
        { agent_run_id: 'run-1', event_type: 'run_completed', payload_json: JSON.stringify({ response: 'Which city?' }), created_at: '2026-06-25T10:00:01.000Z' },
        { agent_run_id: 'run-1', event_type: 'run_started', payload_json: JSON.stringify({ transcript: 'Pune.' }), created_at: '2026-06-25T10:00:10.000Z' },
      ],
      Date.parse('2026-06-25T11:00:00.000Z')
    );

    // The reply never finished, so the run is interrupted, not still showing the earlier answer's status.
    expect(summary).toMatchObject({ transcript: 'Weather?', status: 'interrupted' });
  });
});
