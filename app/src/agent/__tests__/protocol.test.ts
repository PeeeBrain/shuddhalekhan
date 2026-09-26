import { describe, expect, it } from 'bun:test';
import { parseElectronMessage } from '../protocol';

describe('parseElectronMessage', () => {
  it('parses supported main-to-sidecar messages', () => {
    const agentRunId = 'run-1';
    expect(parseElectronMessage(JSON.stringify({ type: 'agent:start', agentRunId, transcript: 'do the thing' }))).toEqual({
      type: 'agent:start',
      agentRunId,
      transcript: 'do the thing',
    });
    expect(parseElectronMessage(JSON.stringify({ type: 'agent:cancel', agentRunId }))).toEqual({ type: 'agent:cancel', agentRunId });
    expect(parseElectronMessage(JSON.stringify({ type: 'sidecar:shutdown' }))).toEqual({ type: 'sidecar:shutdown' });
  });

  it('rejects unknown protocol messages and malformed JSON', () => {
    expect(parseElectronMessage(JSON.stringify({ type: 'agent:unknown', agentRunId: 'run-1' }))).toBeNull();
    expect(parseElectronMessage('{not json')).toBeNull();
  });
});
