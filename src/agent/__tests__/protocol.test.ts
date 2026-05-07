import { describe, expect, it } from 'bun:test';
import { parseElectronMessage } from '../protocol';

const config = {
  whisperUrl: 'http://localhost:8080/inference',
  selectedDeviceId: null,
  removeFillerWords: true,
  agent: {
    enabled: true,
    provider: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4.1-mini',
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
    },
    mcpServers: [],
  },
};

describe('parseElectronMessage', () => {
  it('parses supported JSONL sidecar messages', () => {
    expect(parseElectronMessage(JSON.stringify({ type: 'config:update', config }))).toEqual({
      type: 'config:update',
      config,
    });
    expect(parseElectronMessage(JSON.stringify({
      type: 'agent:start',
      agentRunId: 'run-1',
      transcript: 'check mail',
    }))).toEqual({
      type: 'agent:start',
      agentRunId: 'run-1',
      transcript: 'check mail',
    });
    expect(parseElectronMessage(JSON.stringify({ type: 'agent:cancel', agentRunId: 'run-1' }))).toEqual({
      type: 'agent:cancel',
      agentRunId: 'run-1',
    });
    expect(parseElectronMessage(JSON.stringify({
      type: 'approval:decision',
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      decision: 'denied',
      message: 'no',
    }))).toEqual({
      type: 'approval:decision',
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      decision: 'denied',
      message: 'no',
    });
  });

  it('rejects unknown protocol messages', () => {
    expect(parseElectronMessage(JSON.stringify({ type: 'agent:unknown', agentRunId: 'run-1' }))).toBeNull();
  });
});
