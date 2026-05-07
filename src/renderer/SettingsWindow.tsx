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
              placeholder="OPENROUTER_API_KEY"
              warning={looksLikeRawApiKey(config.agent.provider.apiKeyEnvVar)
                ? 'Enter the environment variable name here, not the API key value. Example: OPENROUTER_API_KEY.'
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
  const addCustomServer = () => {
    onChange([
      ...servers,
      {
        id: makeServerId('mcp'),
        displayName: 'Local MCP Server',
        enabled: false,
        transport: {
          type: 'stdio',
          command: '',
          args: [],
          envVarNames: [],
        },
        discoveredTools: [],
        toolPolicies: {},
      },
    ]);
  };

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

  const updateServer = (serverId: string, updater: (server: McpServerConfig) => McpServerConfig) => {
    onChange(servers.map((server) => (server.id === serverId ? updater(server) : server)));
  };

  const removeServer = (serverId: string) => {
    onChange(servers.filter((server) => server.id !== serverId));
  };

  return (
    <div className="mcp-settings">
      <div className="mcp-actions">
        <button type="button" className="primary-action" onClick={addCustomServer}>
          Add Server
        </button>
        <button type="button" className="secondary-action" disabled={servers.some((server) => server.preset === 'gmail')} onClick={addGmailPreset}>
          Add Gmail Preset
        </button>
      </div>

      {servers.length === 0 ? (
        <div className="empty-mcp">No MCP servers configured.</div>
      ) : (
        <div className="mcp-list">
          {servers.map((server) => (
            <McpServerEditor
              key={server.id}
              server={server}
              status={statuses[server.id]}
              onChange={(updater) => updateServer(server.id, updater)}
              onRemove={() => removeServer(server.id)}
              onTest={() => onTest(server.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function McpServerEditor({
  server,
  status,
  onChange,
  onRemove,
  onTest,
}: {
  server: McpServerConfig;
  status?: McpServerRuntimeStatus;
  onChange: (updater: (server: McpServerConfig) => McpServerConfig) => void;
  onRemove: () => void;
  onTest: () => void;
}) {
  const transport = server.transport;

  return (
    <section className="mcp-server">
      <div className="mcp-server-head">
        <label className="compact-field">
          <span>Name</span>
          <input value={server.displayName} onChange={(event) => onChange((current) => ({ ...current, displayName: event.target.value }))} />
        </label>
        <span className={`mcp-status ${status?.status ?? 'disconnected'}`}>{status?.status ?? 'not tested'}</span>
      </div>

      <label className="mcp-enable">
        <input type="checkbox" checked={server.enabled} onChange={(event) => onChange((current) => ({ ...current, enabled: event.target.checked }))} />
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
              onChange((current) => ({
                ...current,
                transport:
                  type === 'http'
                    ? { type: 'http', url: '' }
                    : { type: 'stdio', command: '', args: [], envVarNames: [] },
              }));
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
              onChange={(event) => onChange((current) => current.transport.type === 'http'
                ? { ...current, transport: { ...current.transport, url: event.target.value } }
                : current)}
            />
          </label>
        ) : (
          <>
            <label className="compact-field">
              <span>Command</span>
              <input
                value={transport.command}
                placeholder="bun"
                onChange={(event) => onChange((current) => current.transport.type === 'stdio'
                  ? { ...current, transport: { ...current.transport, command: event.target.value } }
                  : current)}
              />
            </label>
            <label className="compact-field">
              <span>Arguments</span>
              <input
                value={transport.args.join(' ')}
                placeholder="run path/to/server.ts"
                onChange={(event) => onChange((current) => current.transport.type === 'stdio'
                  ? { ...current, transport: { ...current.transport, args: splitList(event.target.value) } }
                  : current)}
              />
            </label>
            <label className="compact-field span-2">
              <span>Environment variable names</span>
              <input
                value={transport.envVarNames.join(', ')}
                placeholder="GITHUB_TOKEN, GOOGLE_CLIENT_ID"
                onChange={(event) => onChange((current) => current.transport.type === 'stdio'
                  ? { ...current, transport: { ...current.transport, envVarNames: splitCommaList(event.target.value) } }
                  : current)}
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

      {status?.message ? <p className="mcp-error">{status.message}</p> : null}

      <ToolPolicyEditor server={server} onChange={onChange} />

      <div className="mcp-row-actions">
        <button type="button" className="secondary-action" onClick={onTest}>
          Test and Discover Tools
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
  onChange: (updater: (server: McpServerConfig) => McpServerConfig) => void;
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
                onChange((current) => ({
                  ...current,
                  toolPolicies: {
                    ...current.toolPolicies,
                    [policyKey]: nextPolicy,
                  },
                }));
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

function makeServerId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
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
