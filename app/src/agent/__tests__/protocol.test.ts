import { describe, expect, it } from 'bun:test';
import { parseElectronMessage } from '../protocol';

describe('parseElectronMessage', () => {
  it('rejects unknown protocol messages and malformed JSON', () => {
    expect(parseElectronMessage(JSON.stringify({ type: 'agent:unknown', agentRunId: 'run-1' }))).toBeNull();
    expect(parseElectronMessage('{not json')).toBeNull();
  });
});
