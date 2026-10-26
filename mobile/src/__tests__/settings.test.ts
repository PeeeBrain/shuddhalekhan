import { expect, test } from 'bun:test';
import { defaultSettings, mobileSettingsSchema } from '../settings';

test('disabled Agent Mode leaves Dictation independent of unused agent and MCP endpoints', () => {
  const settings = { ...defaultSettings, agentEnabled: false, agentEndpoint: 'unfinished',
    mcpServers: [{ id: 'one', name: 'Local tools', endpoint: 'http://192.168.1.10:3000/mcp', enabled: true, token: '' }],
  };
  expect(mobileSettingsSchema.safeParse(settings).success).toBe(true);
  expect(mobileSettingsSchema.safeParse({ ...settings, agentEnabled: true }).success).toBe(false);
});

test('on-device transcription ignores a dormant endpoint but validates enabled Agent Mode', () => {
  const local = { ...defaultSettings, transcriptionSource: 'on-device', transcriptionEndpoint: 'unfinished' };
  expect(mobileSettingsSchema.safeParse(local).success).toBe(true);
  expect(mobileSettingsSchema.safeParse({ ...local, transcriptionSource: 'endpoint' }).success).toBe(false);
  expect(mobileSettingsSchema.safeParse({ ...local, agentEnabled: true, agentEndpoint: 'unfinished' }).success).toBe(false);
});
