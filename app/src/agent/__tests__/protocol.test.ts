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

  it('requires a correlated, valid provider payload for model testing', () => {
    const provider = { baseUrl: 'http://localhost:11434/v1', model: 'local', apiKeyEnvVar: '' };
    expect(parseElectronMessage(JSON.stringify({ type: 'provider:test', requestId: 'check-1', provider }))).toMatchObject({ type: 'provider:test', requestId: 'check-1', provider });
    for (const message of [
      { type: 'provider:test', provider },
      { type: 'provider:test', requestId: 'check-1', provider: { ...provider, auth: 'guess' } },
      { type: 'provider:cancel-test', requestId: '' },
    ]) expect(parseElectronMessage(JSON.stringify(message))).toBeNull();
  });
});
