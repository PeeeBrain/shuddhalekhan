import { expect, test } from 'bun:test';
import { defaultSettings, mobileSettingsSchema } from '../settings';
import { selectAgentApiMode, selectAgentProvider, selectTranscriptionProvider } from '../providers';

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

test('on-device transcription accepts regional variants of Parakeet languages and rejects languages it lacks', () => {
  const local = { ...defaultSettings, transcriptionSource: 'on-device' };
  expect(mobileSettingsSchema.parse({ ...local, language: 'English (India)' }).language).toBe('en-IN');
  expect(mobileSettingsSchema.safeParse({ ...local, language: 'hi' }).success).toBe(false);
  expect(mobileSettingsSchema.safeParse({ ...local, language: 'hi', transcriptionSource: 'endpoint' }).success).toBe(true);
});

test('switching providers never carries a credential to the new service', () => {
  const keyed = { ...defaultSettings, transcriptionKey: 'openai-secret', googleServiceAccount: '{}', agentKey: 'agent-secret' };
  expect(selectTranscriptionProvider(keyed, 'sarvam')).toMatchObject({ transcriptionKey: '', googleServiceAccount: '' });
  expect(selectAgentProvider(keyed, 'openrouter')).toMatchObject({ agentKey: '', agentApiMode: 'chat-completions' });
});

test('changing the agent API keeps a standard endpoint pointed at that API', () => {
  const openai = selectAgentProvider(defaultSettings, 'azure-openai');
  const azure = { ...openai, agentEndpoint: 'https://r.openai.azure.com/openai/v1/responses' };
  expect(selectAgentApiMode(azure, 'chat-completions').agentEndpoint).toBe('https://r.openai.azure.com/openai/v1/chat/completions');
  expect(mobileSettingsSchema.safeParse({ ...azure, agentEnabled: true, agentModel: 'd', agentProvider: 'openrouter' }).success).toBe(false);
});

test('empty remote endpoints fail validation while unused local endpoints remain editable', () => {
  const incomplete = { ...defaultSettings, transcriptionEndpoint: '' };
  expect(mobileSettingsSchema.safeParse(incomplete).success).toBe(false);
  expect(mobileSettingsSchema.safeParse({ ...incomplete, transcriptionSource: 'on-device' }).success).toBe(true);
});

test('ChatGPT selection clears the API key and model and requires a model before enabling Agent Mode', () => {
  const settings = selectAgentProvider({ ...defaultSettings, agentKey: 'old-secret', agentCache: true }, 'chatgpt');
  expect(settings).toMatchObject({ agentKey: '', agentModel: '', agentAuth: 'none', agentApiMode: 'responses', agentCache: false });
  expect(mobileSettingsSchema.safeParse({ ...settings, agentEnabled: true }).success).toBe(false);
  const configured = { ...settings, agentEnabled: true, agentModel: 'listed-model' };
  expect(mobileSettingsSchema.safeParse(configured).success).toBe(true);
  for (const invalid of [{ agentEndpoint: 'https://other.example/responses' }, { agentAuth: 'bearer' }, { agentKey: 'secret' },
    { agentApiMode: 'chat-completions' }, { agentCache: true }]) {
    expect(mobileSettingsSchema.safeParse({ ...configured, ...invalid }).success).toBe(false);
  }
  expect(selectAgentApiMode(configured, 'chat-completions')).toEqual(configured);
});

test('custom instructions are limited to 4000 characters and the old editable prompt is discarded', () => {
  const legacy = { ...defaultSettings, customInstructions: undefined, systemPrompt: 'Replace the app prompt' };
  const parsed = mobileSettingsSchema.parse(legacy);
  expect(parsed.customInstructions).toBe('');
  expect(parsed).not.toHaveProperty('systemPrompt');
  expect(mobileSettingsSchema.safeParse({ ...defaultSettings, customInstructions: 'x'.repeat(4000) }).success).toBe(true);
  expect(mobileSettingsSchema.safeParse({ ...defaultSettings, customInstructions: 'x'.repeat(4001) }).success).toBe(false);
});
