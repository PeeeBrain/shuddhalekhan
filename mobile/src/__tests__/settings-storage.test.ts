import { describe, expect, test } from 'bun:test';
import { createSettingsStore } from '../settings-storage';
import { defaultSettings, type MobileSettings } from '../settings';

const metadataKey = 'shuddhalekhan.settings';

function createHarness(generations: string[]) {
  const metadataItems = new Map<string, string>();
  const secretItems = new Map<string, string>();
  const faults: { metadataWrite: boolean; secretValue: string | null } = {
    metadataWrite: false,
    secretValue: null,
  };
  const store = createSettingsStore({
    metadata: {
      getItem: async key => metadataItems.get(key) ?? null,
      setItem: async (key, value) => {
        if (faults.metadataWrite) throw new Error(`metadata rejected ${value}`);
        metadataItems.set(key, value);
      },
    },
    secrets: {
      getItem: async key => secretItems.get(key) ?? null,
      setItem: async (key, value) => {
        if (faults.secretValue === value) throw new Error(`secure storage rejected ${value}`);
        secretItems.set(key, value);
      },
      deleteItem: async key => { secretItems.delete(key); },
    },
    createId: () => {
      const generation = generations.shift();
      if (!generation) throw new Error('No generation configured.');
      return generation;
    },
  });
  return { store, metadataItems, secretItems, faults };
}

function configuredSettings(overrides: Partial<MobileSettings> = {}): MobileSettings {
  return {
    ...defaultSettings,
    transcriptionKey: 'transcription-secret',
    agentKey: 'agent-secret',
    mcpServers: [{
      id: 'server-1',
      name: 'Tools',
      endpoint: 'https://tools.example/mcp',
      token: 'mcp-secret',
      enabled: true,
    }],
    ...overrides,
  };
}

describe('settings storage', () => {
  test('returns defaults only when no settings have been saved', async () => {
    const { store } = createHarness([]);
    expect(await store.loadSettings()).toEqual(defaultSettings);
  });

  test('upgrading endpoint settings retains the saved credentials and defaults to the endpoint source', async () => {
    const { store, metadataItems } = createHarness(['generation-1', 'generation-2']);
    const original = configuredSettings();
    await store.saveSettings(original);
    const raw: unknown = JSON.parse(metadataItems.get(metadataKey)!);
    if (typeof raw !== 'object' || raw === null || !('settings' in raw) ||
        typeof raw.settings !== 'object' || raw.settings === null || !('transcriptionSource' in raw.settings)) throw new Error('Invalid fixture');
    delete raw.settings.transcriptionSource;
    metadataItems.set(metadataKey, JSON.stringify(raw));
    expect(await store.loadSettings()).toEqual(original);
    const local = { ...original, transcriptionSource: 'on-device' as const, transcriptionEndpoint: 'unfinished' };
    await store.saveSettings(local);
    expect(await store.loadSettings()).toEqual(local);
  });

  test('settings saved before providers existed keep their generic behavior and normalize the free-text language', async () => {
    const { store, metadataItems } = createHarness(['generation-1']);
    const original = configuredSettings({ transcriptionProvider: 'custom-open-ai-compatible', agentProvider: 'openai-compatible',
      transcriptionEndpoint: 'https://whisper.example/inference', language: 'en-IN', systemPrompt: 'Saved instructions. '.repeat(300) });
    await store.saveSettings(original);
    const raw = JSON.parse(metadataItems.get(metadataKey)!) as { settings: Record<string, unknown> };
    for (const key of ['transcriptionProvider', 'transcriptionAuth', 'transcriptionHeaderName', 'azureRegion', 'googleProject',
      'googleLocation', 'googleServiceAccountRef', 'sarvamMode', 'nimAutoLanguage', 'nimDictionary',
      'agentProvider', 'agentApiMode', 'agentAuth', 'agentReasoning', 'agentCache']) delete raw.settings[key];
    raw.settings.language = 'en_in';
    metadataItems.set(metadataKey, JSON.stringify(raw));
    expect(await store.loadSettings()).toEqual(original);
  });

  test('legacy local settings ignore an unsupported endpoint language without losing credentials or MCP setup', async () => {
    const { store, metadataItems } = createHarness(['generation-1']);
    const original = configuredSettings({ transcriptionSource: 'on-device', language: '' });
    await store.saveSettings(original);
    const raw = JSON.parse(metadataItems.get(metadataKey)!) as { settings: Record<string, unknown> };
    delete raw.settings.transcriptionProvider;
    raw.settings.language = 'hi';
    metadataItems.set(metadataKey, JSON.stringify(raw));
    expect(await store.loadSettings()).toEqual({ ...original, transcriptionProvider: 'custom-open-ai-compatible' });
    expect(metadataItems.get(metadataKey)).toContain('"language":"hi"');
  });

  test('persists tool policies, keeps credentials out of metadata and retires old generation secrets after commit', async () => {
    const { store, metadataItems, secretItems } = createHarness(['generation-1', 'generation-2']);
    const firstServer: MobileSettings['mcpServers'][number] = {
      id: 'server-1',
      name: 'Tools',
      endpoint: 'https://tools.example/mcp',
      token: 'mcp-secret',
      enabled: true,
      toolPolicies: { search: 'alwaysAllow', delete: 'disabled' },
    };
    const first = configuredSettings({ mcpServers: [firstServer], googleServiceAccount: '{"private_key":"google-secret"}' });
    const second = configuredSettings({
      transcriptionKey: 'next-transcription-secret',
      agentKey: 'next-agent-secret',
      mcpServers: [{ ...firstServer, token: 'next-mcp-secret' }],
      googleServiceAccount: '{"private_key":"next-google-secret"}',
    });

    await store.saveSettings(first);
    const oldKeys = [...secretItems.keys()];
    await store.saveSettings(second);

    const metadata = metadataItems.get(metadataKey)!;
    expect(metadata).not.toContain(first.transcriptionKey);
    expect(metadata).not.toContain(first.agentKey);
    expect(metadata).not.toContain(firstServer.token);
    expect(metadata).not.toContain('google-secret');
    expect(oldKeys.every(key => !secretItems.has(key))).toBe(true);
    expect(await store.loadSettings()).toEqual(second);
  });

  test('cleans staged secrets and preserves the saved settings after storage failures', async () => {
    const { store, metadataItems, secretItems, faults } = createHarness([
      'generation-1',
      'generation-2',
      'generation-3',
    ]);
    const saved = configuredSettings();
    await store.saveSettings(saved);
    const savedMetadata = metadataItems.get(metadataKey);
    const savedSecretKeys = [...secretItems.keys()];

    faults.secretValue = 'next-agent-secret';
    await expect(store.saveSettings(configuredSettings({
      transcriptionKey: 'next-transcription-secret',
      agentKey: 'next-agent-secret',
    }))).rejects.toThrow('Could not save settings securely. Existing settings were kept.');
    faults.secretValue = null;
    expect(metadataItems.get(metadataKey)).toBe(savedMetadata);
    expect([...secretItems.keys()].sort()).toEqual(savedSecretKeys.sort());
    expect(await store.loadSettings()).toEqual(saved);

    faults.metadataWrite = true;
    await expect(store.saveSettings(configuredSettings({
      transcriptionKey: 'later-transcription-secret',
      agentKey: 'later-agent-secret',
    }))).rejects.toThrow('Could not save settings securely. Existing settings were kept.');
    faults.metadataWrite = false;
    expect(metadataItems.get(metadataKey)).toBe(savedMetadata);
    expect([...secretItems.keys()].sort()).toEqual(savedSecretKeys.sort());
    expect(await store.loadSettings()).toEqual(saved);
  });

  test('throws on corrupt metadata or a missing referenced secret instead of returning defaults', async () => {
    const { store, metadataItems, secretItems } = createHarness(['generation-1']);
    metadataItems.set(metadataKey, '{not json');
    await expect(store.loadSettings()).rejects.toThrow('Saved settings are corrupt or invalid.');

    await store.saveSettings(configuredSettings());
    secretItems.delete('shuddhalekhan.settings.generation-1.transcription');
    await expect(store.loadSettings()).rejects.toThrow('Could not load saved settings. Check device secure storage.');
  });
});
