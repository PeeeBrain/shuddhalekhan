import Store from 'electron-store';
import { app } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import type { AppConfig, McpDiscoveredTool } from '../types/ipc';
import { normalizeMcpServers } from '../agent/mcp-server-config';

type StoreConfig = AppConfig & {
  migrated?: boolean;
};

const store = new Store<StoreConfig>({
  name: 'shuddhalekhan-config',
  defaults: {
    whisperUrl: 'http://localhost:8080/inference',
    selectedDeviceId: null,
    removeFillerWords: true,
    language: 'auto',
    task: 'transcribe',
    dictionary: [],
    pasteStrategy: {
      default: 'ctrl-v',
      overrides: {},
    },
    setupChecklistDismissed: false,
    recordingActivationMode: 'push-to-talk',
    agent: {
      enabled: false,
      provider: {
        baseUrl: '',
        model: '',
        apiKeyEnvVar: '',
        thinkingEnabled: true,
      },
      mcpServers: [],
    },
  },
});

// Migrate old config from ~/.speech-2-text/config.json on first run
function maybeMigrateLegacyConfig(): void {
  const legacyDir = join(app.getPath('home'), '.speech-2-text');
  const legacyPath = join(legacyDir, 'config.json');

  if (existsSync(legacyPath) && !store.get('migrated')) {
    try {
      const raw = readFileSync(legacyPath, 'utf-8');
      const legacy = JSON.parse(raw);

      if (legacy.whisper_url) store.set('whisperUrl', legacy.whisper_url);
      if (legacy.selected_device) store.set('selectedDeviceId', legacy.selected_device);
      if (typeof legacy.remove_filler_words === 'boolean') {
        store.set('removeFillerWords', legacy.remove_filler_words);
      }

      store.set('migrated', true);
      // Clean up legacy file
      try {
        unlinkSync(legacyPath);
      } catch {
        // ignore cleanup failure
      }
    } catch {
      // ignore malformed legacy config
    }
  }
}

maybeMigrateLegacyConfig();

export function getConfig(): AppConfig {
  const agent = store.get('agent');
  const mcpServers = normalizeMcpServers(agent?.mcpServers);
  const recordingActivationMode = store.get('recordingActivationMode') === 'toggle'
    ? 'toggle'
    : 'push-to-talk';

  return {
    whisperUrl: store.get('whisperUrl'),
    selectedDeviceId: store.get('selectedDeviceId'),
    removeFillerWords: store.get('removeFillerWords'),
    language: store.get('language') ?? 'auto',
    task: store.get('task') ?? 'transcribe',
    dictionary: store.get('dictionary') ?? [],
    pasteStrategy: store.get('pasteStrategy') ?? { default: 'ctrl-v', overrides: {} },
    setupChecklistDismissed: store.get('setupChecklistDismissed') ?? false,
    recordingActivationMode,
    agent: {
      enabled: agent?.enabled ?? false,
      provider: {
        baseUrl: agent?.provider?.baseUrl ?? '',
        model: agent?.provider?.model ?? '',
        apiKeyEnvVar: agent?.provider?.apiKeyEnvVar ?? '',
        thinkingEnabled: agent?.provider?.thinkingEnabled ?? true,
      },
      mcpServers,
    },
  };
}

export function setConfig<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
  store.set(key, value);
}

export function mergeDiscoveredTools(
  serverId: string,
  tools: Array<{ name: string; description: string; inputSchema?: unknown }>
): void {
  const config = getConfig();
  const discoveredAt = new Date().toISOString();
  const mcpServers = config.agent.mcpServers.map((server) => {
    if (server.id !== serverId) return server;

    const discoveredTools: McpDiscoveredTool[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      discoveredAt,
    }));
    const toolPolicies = { ...server.toolPolicies };
    for (const tool of discoveredTools) {
      const key = `${server.id}:${tool.name}` as const;
      if (!toolPolicies[key]) toolPolicies[key] = 'alwaysAsk';
    }

    return {
      ...server,
      discoveredTools,
      toolPolicies,
    };
  });

  store.set('agent', {
    ...config.agent,
    mcpServers,
  });
}
