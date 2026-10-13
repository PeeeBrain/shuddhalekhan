import { describe, expect, it } from 'bun:test';
import { normalizeAgentProvider } from '../agent-provider';
import { getAgentProviderIssues, resolveAgentProviderKey } from '../agent-provider-validation';

const local = { baseUrl: 'http://[::1]:11434/v1/', model: ' local ', apiKeyEnvVar: '' };

describe('Agent provider configuration', () => {
  it('migrates provider identities and reasoning without switching API mode or endpoints', () => {
    const azure = normalizeAgentProvider({ ...local, baseUrl: 'https://resource.openai.azure.com/openai/v1', model: 'production', thinkingEnabled: true, reasoningEffort: 'high', apiKeyEnvVar: 'AZURE_KEY' });
    expect(azure).toMatchObject({ kind: 'azure-openai', apiMode: 'chat-completions', auth: 'api-key', reasoning: 'high', model: 'production', cacheBreakpoints: false });
    expect(normalizeAgentProvider(local)).toMatchObject({ auth: 'none', reasoning: 'default', model: 'local', baseUrl: 'http://[::1]:11434/v1' });
    expect(normalizeAgentProvider({ ...local, thinkingEnabled: false })).toMatchObject({ reasoning: 'default' });
    for (const baseUrl of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', local.baseUrl]) {
      const legacy = { ...local, baseUrl, apiKeyEnvVar: 'STALE_REMOTE_KEY' };
      expect(resolveAgentProviderKey(legacy, undefined, {}).validation).toEqual({ credentials: 'not-required', issues: [] });
      expect(normalizeAgentProvider({ ...legacy, auth: 'bearer' }).auth).toBe('bearer');
      expect(normalizeAgentProvider({ ...legacy, apiKeySource: 'stored' }).auth).toBe('bearer');
    }
  });

  it('rejects full request routes, URL credentials, legacy Azure URLs, and unsafe remote HTTP', () => {
    for (const baseUrl of [
      'https://resource.openai.azure.com',
      'https://resource.openai.azure.com/openai/deployments/production/chat/completions?api-version=2024-10-21',
      'https://user:secret@example.com/v1', 'file:///model', 'http://remote.example/v1',
    ]) {
      expect(getAgentProviderIssues({ ...local, baseUrl }).some(issue => issue.field === 'baseUrl')).toBe(true);
    }
    expect(getAgentProviderIssues({ ...local, baseUrl: 'http://192.168.1.4:8000/v1', auth: 'none', allowInsecureHttp: true })).toEqual([]);
  });

  it('never substitutes a dummy key for an explicitly missing credential', () => {
    const missing = resolveAgentProviderKey({ ...local, auth: 'bearer', apiKeyEnvVar: 'LOCAL_KEY' }, undefined, {});
    expect(missing.validation.credentials).toBe('missing');
    expect(missing.validation.issues[0]?.field).toBe('apiKeyEnvVar');
    expect(missing.apiKey).toBeUndefined();
    expect(resolveAgentProviderKey({ ...local, auth: 'bearer', apiKeyEnvVar: 'constructor' }, undefined, {}).validation.credentials).toBe('missing');
    const none = resolveAgentProviderKey({ ...local, auth: 'none' }, undefined, {});
    expect(none.validation).toEqual({ credentials: 'not-required', issues: [] });
    const stored = resolveAgentProviderKey({ ...local, auth: 'api-key', apiKeySource: 'stored' }, 'saved-secret', {});
    expect(stored.validation).toEqual({ credentials: 'available', issues: [] });
    expect(JSON.stringify(stored.validation)).not.toContain('saved-secret');
    for (const auth of ['none', 'api-key'] as const) {
      const inactive = resolveAgentProviderKey({ ...local, auth, apiKeySource: 'stored', apiKeyEnvVar: 'sk-old-unused-key' }, 'saved-secret', {});
      expect(inactive.validation.issues).toEqual([]);
    }
    const badHeader = resolveAgentProviderKey({ ...local, auth: 'api-key', apiKeySource: 'stored' }, 'secret\nvalue', {});
    expect(badHeader.validation.issues[0]?.message).toContain('invalid header characters');
    expect(JSON.stringify(badHeader.validation)).not.toContain('secret');
  });
});
