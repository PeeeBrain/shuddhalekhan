import { describe, expect, it } from 'bun:test';
import { AgentMemoryCommitter } from '../memory-committer';
import type { SidecarEvent } from '../protocol';

describe('memory proposal acknowledgments', () => {
  it('correlates the acknowledgment by both request and run, and releases cancellation', async () => {
    const messages: SidecarEvent[] = [];
    const committer = new AgentMemoryCommitter(event => messages.push(event));
    const controller = new AbortController();
    const request = committer.request('run-1', 'revision-1', [{ previous: null, text: 'The user prefers concise answers.' }], controller.signal);
    const sent = messages[0];
    if (sent.type !== 'memory:propose') throw new Error('Expected a proposal.');
    committer.accept({ type: 'memory:commit-result', requestId: sent.requestId, agentRunId: 'old-run', result: { saved: true } });
    committer.accept({ type: 'memory:commit-result', requestId: 'old-request', agentRunId: 'run-1', result: { saved: true } });
    committer.accept({ type: 'memory:commit-result', requestId: sent.requestId, agentRunId: 'run-1', result: { saved: false, message: 'Memory changed.' } });
    expect(await request).toEqual({ saved: false, message: 'Memory changed.' });
    const cancelled = committer.request('run-2', 'revision-2', [], controller.signal);
    controller.abort();
    expect(await cancelled).toMatchObject({ saved: false, message: expect.stringContaining('interrupted') });
    const count = messages.length;
    expect(await committer.request('run-3', 'revision-3', [], controller.signal)).toMatchObject({ saved: false });
    expect(messages).toHaveLength(count);
  });
});
