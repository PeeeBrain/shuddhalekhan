import { useEffect, useMemo, useState } from 'react';
import type {
  AgentToolApprovalPolicy,
  AppConfig,
  AppInfo,
  McpServerConfig,
  McpServerRuntimeStatus,
  UpdateStatus,
} from '../types/ipc';

type SettingsSection = 'general' | 'audio' | 'agent' | 'mcp' | 'about';

const sections: Array<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'audio', label: 'Audio' },
  { id: 'agent', label: 'Agent' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'about', label: 'About' },
];

export function SettingsWindow() {
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const [config, setConfigState] = useState<AppConfig | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [mcpStatuses, setMcpStatuses] = useState<Record<string, McpServerRuntimeStatus>>({});
  const [saveState, setSaveState] = useState<'idle' | 'saved'>('idle');

  useEffect(() => {
    window.electronAPI?.invoke('config:get').then(setConfigState).catch((err) => {
      console.error('Failed to load settings config:', err);
    });
    window.electronAPI?.invoke('app:get-info').then(setAppInfo).catch((err) => {
      console.error('Failed to load app info:', err);
    });
    window.electronAPI?.invoke('updater:get-status').then(setUpdateStatus).catch((err) => {
      console.error('Failed to load update status:', err);
    });

    const offUpdater = window.electronAPI?.on('updater:status-changed', setUpdateStatus);
    const offMcpStatus = window.electronAPI?.on('mcp:server-status', (status) => {
      setMcpStatuses((current) => ({ ...current, [status.serverId]: status }));
      window.electronAPI?.invoke('config:get').then(setConfigState).catch((err) => {
        console.error('Failed to refresh MCP tools:', err);
      });
    });

    return () => {
      offUpdater?.();
      offMcpStatus?.();
    };
  }, []);

  const updateConfig = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    setConfigState((current) => current ? { ...current, [key]: value } : current);
    window.electronAPI?.invoke('config:set', key, value);
    setSaveState('saved');
    window.setTimeout(() => setSaveState('idle'), 1200);
  };

  const updateAgent = (agent: AppConfig['agent']) => updateConfig('agent', agent);

  const statusText = useMemo(() => {
    if (!updateStatus) return 'Update status unavailable';
    return updateStatus.message;
  }, [updateStatus]);

  if (!config) {
    return (
      <main className="settings-shell loading">
        <p>Loading settings...</p>
      </main>
    );
  }

  const updateMcpServers = (mcpServers: McpServerConfig[]) => updateAgent({ ...config.agent, mcpServers });

  return (
    <main className="settings-shell">
      <aside className="settings-rail" aria-label="Settings sections">
        <div className="settings-brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>Shuddhalekhan</h1>
            <p>{appInfo?.version ? `v${appInfo.version}` : 'Settings'}</p>
          </div>
        </div>

        <nav>
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={activeSection === section.id ? 'active' : ''}
              onClick={() => setActiveSection(section.id)}
            >
              {section.label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="settings-content">
        <header className="settings-header">
          <div>
            <p className="eyebrow">Configuration</p>
            <h2>{sections.find((section) => section.id === activeSection)?.label}</h2>
          </div>
          <span className={`save-indicator ${saveState}`}>{saveState === 'saved' ? 'Saved' : 'Ready'}</span>
        </header>

        {activeSection === 'general' ? (
          <SettingsPanel>
            <ToggleRow
              title="Clean transcription"
              description="Remove common filler words before dictation text is injected."
              checked={config.removeFillerWords}
              onChange={(checked) => updateConfig('removeFillerWords', checked)}
            />
            <KeyRow label="Dictation hotkey" value="Ctrl + Win" />
            <KeyRow label="Agent hotkey" value="Alt + Win" />
          </SettingsPanel>
        ) : null}

        {activeSection === 'audio' ? (
          <SettingsPanel>
            <TextRow
              label="Whisper endpoint"
              value={config.whisperUrl}
              placeholder="http://localhost:8080/inference"
              onChange={(value) => updateConfig('whisperUrl', value)}
            />
            <ReadOnlyRow label="Selected device" value={config.selectedDeviceId ?? 'Default input device'} />
            <ReadOnlyRow label="Capture path" value="Shared by Dictation and Agent Mode" />
          </SettingsPanel>
        ) : null}

        {activeSection === 'agent' ? (
          <SettingsPanel>
            <ToggleRow
              title="Enable Agent Mode"
              description="Activates the Alt + Win recording intent. Sidecar execution arrives in later phases."
              checked={config.agent.enabled}
              tone="agent"
              onChange={(checked) => updateAgent({ ...config.agent, enabled: checked })}
            />
            <TextRow
              label="Provider base URL"
              value={config.agent.provider.baseUrl}
              placeholder="https://openrouter.ai/api/v1"
              onChange={(baseUrl) => updateAgent({
                ...config.agent,
                provider: { ...config.agent.provider, baseUrl },
              })}
            />
            <TextRow
              label="Model"
              value={config.agent.provider.model}
              placeholder="openai/gpt-4.1-mini"
              onChange={(model) => updateAgent({
                ...config.agent,
                provider: { ...config.agent.provider, model },
              })}
            />
            <TextRow
              label="API key env var name"
              value={config.agent.provider.apiKeyEnvVar}
              placeholder={isLocalProviderUrl(config.agent.provider.baseUrl) ? 'Optional for local providers' : 'OPENROUTER_API_KEY'}
              warning={looksLikeRawApiKey(config.agent.provider.apiKeyEnvVar)
                ? 'Enter the environment variable name here, not the API key value. Example: OPENROUTER_API_KEY.'
                : isLocalProviderUrl(config.agent.provider.baseUrl)
                  ? 'Local providers such as Ollama can leave this empty.'
                : undefined}
              onChange={(apiKeyEnvVar) => updateAgent({
                ...config.agent,
                provider: { ...config.agent.provider, apiKeyEnvVar },
              })}
            />
          </SettingsPanel>
        ) : null}

        {activeSection === 'mcp' ? (
          <McpSettings
            servers={config.agent.mcpServers}
            statuses={mcpStatuses}
            onChange={updateMcpServers}
            onTest={(serverId) => {
              window.electronAPI?.invoke('mcp:test-server', serverId);
            }}
          />
        ) : null}

        {activeSection === 'about' ? (
          <SettingsPanel>
            <ReadOnlyRow label="Version" value={appInfo?.version ?? 'Unknown'} />
            <ReadOnlyRow label="Update status" value={statusText} />
            <button
              type="button"
              className="primary-action"
              disabled={updateStatus?.state === 'checking'}
              onClick={() => {
                window.electronAPI?.invoke('updater:check').then(setUpdateStatus).catch((err) => {
                  console.error('Failed to check for updates:', err);
                });
              }}
            >
              {updateStatus?.state === 'checking' ? 'Checking...' : 'Check for Updates'}
            </button>
          </SettingsPanel>
        ) : null}
      </section>
    </main>
  );
}

function McpSettings({
  servers,
  statuses,
  onChange,
  onTest,
}: {
  servers: McpServerConfig[];
  statuses: Record<string, McpServerRuntimeStatus>;
  onChange: (servers: McpServerConfig[]) => void;
  onTest: (serverId: string) => void;
}) {
  const [draft, setDraft] = useState<McpServerConfig>(() => createBlankMcpServer());
  const [editingServerId, setEditingServerId] = useState<string | null>(null);

  const addGmailPreset = () => {
    if (servers.some((server) => server.preset === 'gmail')) return;

    onChange([
      ...servers,
      {
        id: 'gmail-primary',
        displayName: 'Gmail',
        enabled: false,
        preset: 'gmail',
        transport: {
          type: 'http',
          url: 'https://gmailmcp.googleapis.com/mcp/v1',
          oauth: {
            enabled: true,
            credentialSource: 'userProvided',
            clientIdEnvVar: 'GOOGLE_CLIENT_ID',
            clientSecretEnvVar: 'GOOGLE_CLIENT_SECRET',
          },
        },
        discoveredTools: [],
        toolPolicies: {},
      },
    ]);
  };

  const saveDraft = () => {
    const server = normalizeDraftServer(draft, editingServerId);
    if (editingServerId) {
      onChange(servers.map((item) => (item.id === editingServerId ? { ...server, id: editingServerId } : item)));
    } else {
      onChange([...servers, server]);
    }
    setDraft(createBlankMcpServer());
    setEditingServerId(null);
  };

  const removeServer = (serverId: string) => {
    onChange(servers.filter((server) => server.id !== serverId));
    if (editingServerId === serverId) {
      setDraft(createBlankMcpServer());
      setEditingServerId(null);
    }
  };

  return (
    <div className="mcp-settings">
      <section className="mcp-form-panel">
        <div className="mcp-section-head">
          <div>
            <h3>{editingServerId ? 'Edit MCP Server' : 'Add MCP Server'}</h3>
            <p>Configure one server, save it, then test discovery from the configured list.</p>
          </div>
          <button type="button" className="secondary-action" disabled={servers.some((server) => server.preset === 'gmail')} onClick={addGmailPreset}>
            Add Gmail Preset
          </button>
        </div>

        <McpServerForm server={draft} onChange={setDraft} />

        <div className="mcp-row-actions">
          {editingServerId ? (
            <button
              type="button"
              className="secondary-action"
              onClick={() => {
                setDraft(createBlankMcpServer());
                setEditingServerId(null);
              }}
            >
              Cancel Edit
            </button>
          ) : null}
          <button type="button" className="primary-action" onClick={saveDraft}>
            {editingServerId ? 'Save Changes' : 'Save Server'}
          </button>
        </div>
      </section>

      <section className="mcp-configured-panel">
        <div className="mcp-section-head">
          <div>
            <h3>Configured MCPs</h3>
            <p>{servers.length === 0 ? 'No MCP servers configured.' : `${servers.length} server${servers.length === 1 ? '' : 's'} configured.`}</p>
          </div>
        </div>

        {servers.length === 0 ? (
          <div className="empty-mcp">Saved servers will appear here.</div>
        ) : (
          <div className="mcp-list">
            {servers.map((server) => (
              <ConfiguredMcpServer
                key={server.id}
                server={server}
                status={statuses[server.id]}
                onEdit={() => {
                  setDraft(server);
                  setEditingServerId(server.id);
                }}
                onRemove={() => removeServer(server.id)}
                onTest={() => onTest(server.id)}
                onPolicyChange={(nextServer) => {
                  onChange(servers.map((item) => (item.id === server.id ? nextServer : item)));
                }}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function McpServerForm({
  server,
  onChange,
}: {
  server: McpServerConfig;
  onChange: (server: McpServerConfig) => void;
}) {
  const transport = server.transport;

  return (
    <>
      <label className="compact-field">
        <span>Name</span>
        <input value={server.displayName} onChange={(event) => onChange({ ...server, displayName: event.target.value })} />
      </label>

      <label className="mcp-enable">
        <input type="checkbox" checked={server.enabled} onChange={(event) => onChange({ ...server, enabled: event.target.checked })} />
        <span>Enabled for Agent Mode</span>
      </label>

      <div className="mcp-grid">
        <label className="compact-field">
          <span>Transport</span>
          <select
            value={server.transport.type}
            disabled={server.preset === 'gmail'}
            onChange={(event) => {
              const type = event.target.value;
              onChange({
                ...server,
                transport:
                  type === 'http'
                    ? { type: 'http', url: '' }
                    : { type: 'stdio', command: '', args: [], envVarNames: [] },
              });
            }}
          >
            <option value="stdio">stdio</option>
            <option value="http">HTTP</option>
          </select>
        </label>

        {transport.type === 'http' ? (
          <label className="compact-field span-2">
            <span>URL</span>
            <input
              value={transport.url}
              disabled={server.preset === 'gmail'}
              placeholder="http://localhost:3000/mcp"
              onChange={(event) => onChange({ ...server, transport: { ...transport, url: event.target.value } })}
            />
          </label>
        ) : (
          <>
            <label className="compact-field">
              <span>Command</span>
              <input
                value={transport.command}
                placeholder="bun"
                onChange={(event) => onChange({ ...server, transport: { ...transport, command: event.target.value } })}
              />
            </label>
            <label className="compact-field">
              <span>Arguments</span>
              <input
                value={transport.args.join(' ')}
                placeholder="run path/to/server.ts"
                onChange={(event) => onChange({ ...server, transport: { ...transport, args: splitList(event.target.value) } })}
              />
            </label>
            <label className="compact-field span-2">
              <span>Environment variable names</span>
              <input
                value={transport.envVarNames.join(', ')}
                placeholder="GITHUB_TOKEN, GOOGLE_CLIENT_ID"
                onChange={(event) => onChange({ ...server, transport: { ...transport, envVarNames: splitCommaList(event.target.value) } })}
              />
            </label>
          </>
        )}
      </div>

      {transport.type === 'http' && transport.oauth?.enabled ? (
        <div className="oauth-box">
          <span>OAuth: user-provided Google client env vars</span>
          <code>{transport.oauth.clientIdEnvVar || 'GOOGLE_CLIENT_ID'}</code>
          <code>{transport.oauth.clientSecretEnvVar || 'GOOGLE_CLIENT_SECRET'}</code>
        </div>
      ) : null}
    </>
  );
}

function ConfiguredMcpServer({
  server,
  status,
  onEdit,
  onRemove,
  onTest,
  onPolicyChange,
}: {
  server: McpServerConfig;
  status?: McpServerRuntimeStatus;
  onEdit: () => void;
  onRemove: () => void;
  onTest: () => void;
  onPolicyChange: (server: McpServerConfig) => void;
}) {
  return (
    <section className="mcp-server">
      <div className="mcp-server-head">
        <div className="mcp-card-title">
          <strong>{server.displayName || 'Unnamed MCP Server'}</strong>
          <small>{formatTransport(server)}</small>
        </div>
        <span className={`mcp-status ${status?.status ?? 'disconnected'}`}>{status?.status ?? 'not tested'}</span>
      </div>

      <div className="mcp-card-meta">
        <span>{server.enabled ? 'Enabled for Agent Mode' : 'Disabled'}</span>
        <span>{server.discoveredTools.length} tool{server.discoveredTools.length === 1 ? '' : 's'}</span>
      </div>

      {status?.message ? <p className="mcp-error">{status.message}</p> : null}

      <ToolPolicyEditor server={server} onChange={onPolicyChange} />

      <div className="mcp-row-actions">
        <button type="button" className="secondary-action" onClick={onTest}>
          Test and Discover Tools
        </button>
        <button type="button" className="secondary-action" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="danger-action" onClick={onRemove}>
          Remove
        </button>
      </div>
    </section>
  );
}

function ToolPolicyEditor({
  server,
  onChange,
}: {
  server: McpServerConfig;
  onChange: (server: McpServerConfig) => void;
}) {
  if (server.discoveredTools.length === 0) {
    return <p className="tool-empty">No tools discovered yet.</p>;
  }

  return (
    <div className="tool-policy-list">
      {server.discoveredTools.map((tool) => {
        const policyKey = `${server.id}:${tool.name}` as const;
        const policy = server.toolPolicies[policyKey] ?? 'alwaysAsk';

        return (
          <div className="tool-policy" key={tool.name}>
            <div>
              <strong>{tool.name}</strong>
              <small>{tool.description || 'No description provided.'}</small>
            </div>
            <select
              value={policy}
              onChange={(event) => {
                const nextPolicy = event.target.value as AgentToolApprovalPolicy;
                onChange({
                  ...server,
                  toolPolicies: {
                    ...server.toolPolicies,
                    [policyKey]: nextPolicy,
                  },
                });
              }}
            >
              <option value="alwaysAsk">Always ask</option>
              <option value="alwaysAllow">Always allow</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
        );
      })}
    </div>
  );
}

function SettingsPanel({ children }: { children: React.ReactNode }) {
  return <div className="settings-panel">{children}</div>;
}

function ToggleRow({
  title,
  description,
  checked,
  tone = 'default',
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  tone?: 'default' | 'agent';
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`setting-row toggle-row ${tone}`}>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function TextRow({
  label,
  value,
  placeholder,
  warning,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  warning?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="setting-row input-row">
      <span>{label}</span>
      <span className="input-stack">
        <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
        {warning ? <small className="field-warning">{warning}</small> : null}
      </span>
    </label>
  );
}

function looksLikeRawApiKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_-]/.test(value.trim());
}

function isLocalProviderUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return ['localhost', '127.0.0.1', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

function makeServerId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

function createBlankMcpServer(): McpServerConfig {
  return {
    id: makeServerId('mcp'),
    displayName: '',
    enabled: false,
    transport: {
      type: 'stdio',
      command: '',
      args: [],
      envVarNames: [],
    },
    discoveredTools: [],
    toolPolicies: {},
  };
}

function normalizeDraftServer(server: McpServerConfig, existingId: string | null): McpServerConfig {
  return {
    ...server,
    id: existingId ?? makeServerId('mcp'),
    displayName: server.displayName.trim() || 'MCP Server',
  };
}

function formatTransport(server: McpServerConfig): string {
  if (server.transport.type === 'http') return server.transport.url || 'HTTP endpoint not set';
  return [server.transport.command, ...server.transport.args].filter(Boolean).join(' ') || 'stdio command not set';
}

function splitCommaList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function splitList(value: string): string[] {
  return value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="setting-row readonly-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function KeyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="setting-row key-row">
      <span>{label}</span>
      <kbd>{value}</kbd>
    </div>
  );
}
