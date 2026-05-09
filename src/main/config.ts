import Store from 'electron-store';
import { app } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import type {
  AgentToolApprovalPolicy,
  AppConfig,
  McpServerConfig,
  McpToolPolicyKey,
} from '../types/ipc';

type StoreConfig = AppConfig & {
  migrated?: boolean;
};

const store = new Store<StoreConfig>({
  name: 'shuddhalekhan-config',
  defaults: {
    whisperUrl: 'http://localhost:8080/inference',
    selectedDeviceId: null,
    removeFillerWords: true,
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

const DEFAULT_TOOL_POLICY: AgentToolApprovalPolicy = 'alwaysAsk';

function makeToolPolicyKey(serverId: string, toolName: string): McpToolPolicyKey {
  return `${serverId}:${toolName}`;
}

function normalizeMcpServer(server: McpServerConfig): McpServerConfig {
  const discoveredTools = Array.isArray(server.discoveredTools) ? server.discoveredTools : [];
  const toolPolicies = { ...(server.toolPolicies ?? {}) };

  for (const tool of discoveredTools) {
    const key = makeToolPolicyKey(server.id, tool.name);
    if (!toolPolicies[key]) {
      toolPolicies[key] = DEFAULT_TOOL_POLICY;
    }
  }

  return {
    ...server,
    enabled: server.enabled ?? false,
    discoveredTools,
    toolPolicies,
  };
}

function normalizeMcpServers(servers: McpServerConfig[] | undefined): McpServerConfig[] {
  if (!Array.isArray(servers)) return [];

  const seenPresets = new Set<string>();
  return servers
    .filter((server) => {
      if (server.preset !== 'gmail') return true;
      if (seenPresets.has(server.preset)) return false;
      seenPresets.add(server.preset);
      return true;
    })
    .map(normalizeMcpServer);
}

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

  return {
    whisperUrl: store.get('whisperUrl'),
    selectedDeviceId: store.get('selectedDeviceId'),
    removeFillerWords: store.get('removeFillerWords'),
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
