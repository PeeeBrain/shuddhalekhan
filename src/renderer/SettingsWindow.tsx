import { useEffect, useMemo, useState } from 'react';
import type {
  AgentToolApprovalPolicy,
  AppConfig,
  AppInfo,
  McpServerConfig,
  McpServerRuntimeStatus,
  UpdateStatus,
} from '../types/ipc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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
      <main className="flex h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading settings...</p>
      </main>
    );
  }

  const updateMcpServers = (mcpServers: McpServerConfig[]) => updateAgent({ ...config.agent, mcpServers });

  return (
    <main className="flex h-screen bg-background text-foreground">
      <aside className="flex w-[244px] flex-col border-r border-border bg-[#101214] p-[18px] pt-7" aria-label="Settings sections">
        <div className="mb-8 flex items-center gap-3">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#181b1e] shadow-[inset_0_0_0_1px_#30363c]"
            style={{
              background: 'linear-gradient(#f1c75b, #f1c75b) 50% 50% / 16px 3px no-repeat, linear-gradient(#fff, #fff) 50% 50% / 3px 16px no-repeat, #181b1e',
            }}
            aria-hidden="true"
          />
          <div>
            <h1 className="text-[17px] font-semibold leading-[22px]">Shuddhalekhan</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">{appInfo?.version ? `v${appInfo.version}` : 'Settings'}</p>
          </div>
        </div>

        <nav className="flex flex-col gap-1">
          {sections.map((section) => (
            <Button
              key={section.id}
              type="button"
              variant={activeSection === section.id ? 'secondary' : 'ghost'}
              className="justify-start text-[13px] font-semibold text-muted-foreground hover:text-foreground"
              onClick={() => setActiveSection(section.id)}
            >
              {section.label}
            </Button>
          ))}
        </nav>
      </aside>

      <section className="min-w-0 flex-1 bg-[#181b1e]">
        <ScrollArea className="h-full">
          <div className="px-10 py-8">
            <header className="mb-6 flex items-start justify-between gap-6">
              <div>
                <p className="mb-1 text-xs font-bold uppercase tracking-normal text-muted-foreground">Configuration</p>
                <h2 className="text-[27px] font-semibold leading-[34px] text-[#f7f8f9]">
                  {sections.find((section) => section.id === activeSection)?.label}
                </h2>
              </div>
              <Badge variant="outline" className={saveState === 'saved' ? 'border-primary/45 text-primary' : ''}>
                {saveState === 'saved' ? 'Saved' : 'Ready'}
              </Badge>
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
                <Button
                  className="mt-4 w-fit min-w-[152px]"
                  disabled={updateStatus?.state === 'checking'}
                  onClick={() => {
                    window.electronAPI?.invoke('updater:check').then(setUpdateStatus).catch((err) => {
                      console.error('Failed to check for updates:', err);
                    });
                  }}
                >
                  {updateStatus?.state === 'checking' ? 'Checking...' : 'Check for Updates'}
                </Button>
              </SettingsPanel>
            ) : null}
          </div>
        </ScrollArea>
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
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[0.9fr_1fr]">
      <Card className="border-border/60">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">{editingServerId ? 'Edit MCP Server' : 'Add MCP Server'}</CardTitle>
              <CardDescription>Configure one server, save it, then test discovery from the configured list.</CardDescription>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={servers.some((server) => server.preset === 'gmail')}
              onClick={addGmailPreset}
            >
              Add Gmail Preset
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <McpServerForm server={draft} onChange={setDraft} />

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            {editingServerId ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setDraft(createBlankMcpServer());
                  setEditingServerId(null);
                }}
              >
                Cancel Edit
              </Button>
            ) : null}
            <Button type="button" size="sm" onClick={saveDraft}>
              {editingServerId ? 'Save Changes' : 'Save Server'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-bold text-[#f1f3f5]">Configured MCPs</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {servers.length === 0 ? 'No MCP servers configured.' : `${servers.length} server${servers.length === 1 ? '' : 's'} configured.`}
            </p>
          </div>
        </div>

        {servers.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">Saved servers will appear here.</p>
        ) : (
          <div className="space-y-3">
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
      </div>
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
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-xs font-bold text-muted-foreground">Name</Label>
        <Input
          value={server.displayName}
          onChange={(event) => onChange({ ...server, displayName: event.target.value })}
        />
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id="mcp-enabled"
          checked={server.enabled}
          onCheckedChange={(checked) => onChange({ ...server, enabled: checked })}
        />
        <Label htmlFor="mcp-enabled" className="text-sm text-[#cbd1d6]">Enabled for Agent Mode</Label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-xs font-bold text-muted-foreground">Transport</Label>
          <Select
            value={server.transport.type}
            disabled={server.preset === 'gmail'}
            onValueChange={(type) => {
              onChange({
                ...server,
                transport:
                  type === 'http'
                    ? { type: 'http', url: '' }
                    : { type: 'stdio', command: '', args: [], envVarNames: [] },
              });
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">stdio</SelectItem>
              <SelectItem value="http">HTTP</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {transport.type === 'http' ? (
          <div className="col-span-full space-y-2">
            <Label className="text-xs font-bold text-muted-foreground">URL</Label>
            <Input
              value={transport.url}
              disabled={server.preset === 'gmail'}
              placeholder="http://localhost:3000/mcp"
              onChange={(event) => onChange({ ...server, transport: { ...transport, url: event.target.value } })}
            />
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label className="text-xs font-bold text-muted-foreground">Command</Label>
              <Input
                value={transport.command}
                placeholder="bun"
                onChange={(event) => onChange({ ...server, transport: { ...transport, command: event.target.value } })}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-bold text-muted-foreground">Arguments</Label>
              <Input
                value={transport.args.join(' ')}
                placeholder="run path/to/server.ts"
                onChange={(event) => onChange({ ...server, transport: { ...transport, args: splitList(event.target.value) } })}
              />
            </div>
            <div className="col-span-full space-y-2">
              <Label className="text-xs font-bold text-muted-foreground">Environment variable names</Label>
              <Input
                value={transport.envVarNames.join(', ')}
                placeholder="GITHUB_TOKEN, GOOGLE_CLIENT_ID"
                onChange={(event) => onChange({ ...server, transport: { ...transport, envVarNames: splitCommaList(event.target.value) } })}
              />
            </div>
          </>
        )}
      </div>

      {transport.type === 'http' && transport.oauth?.enabled ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/40 p-3 text-xs text-muted-foreground">
          <span>OAuth: user-provided Google client env vars</span>
          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-primary">{transport.oauth.clientIdEnvVar || 'GOOGLE_CLIENT_ID'}</code>
          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-primary">{transport.oauth.clientSecretEnvVar || 'GOOGLE_CLIENT_SECRET'}</code>
        </div>
      ) : null}
    </div>
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
    <Card className="border-border/60">
      <CardContent className="space-y-3 pt-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#f1f3f5] break-words">{server.displayName || 'Unnamed MCP Server'}</p>
            <p className="mt-0.5 text-xs text-muted-foreground break-words">{formatTransport(server)}</p>
          </div>
          <Badge
            variant="outline"
            className={
              status?.status === 'connected'
                ? 'border-success/40 text-success'
                : status?.status === 'connecting'
                  ? 'border-primary/40 text-primary'
                  : status?.status === 'failed'
                    ? 'border-destructive/40 text-destructive'
                    : ''
            }
          >
            {status?.status ?? 'not tested'}
          </Badge>
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary" className="text-xs">
            {server.enabled ? 'Enabled for Agent Mode' : 'Disabled'}
          </Badge>
          <Badge variant="secondary" className="text-xs">
            {server.discoveredTools.length} tool{server.discoveredTools.length === 1 ? '' : 's'}
          </Badge>
        </div>

        {status?.message ? <p className="text-xs text-destructive break-words">{status.message}</p> : null}

        <ToolPolicyEditor server={server} onChange={onPolicyChange} />

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" size="sm" onClick={onTest}>
            Test and Discover Tools
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={onRemove}>
            Remove
          </Button>
        </div>
      </CardContent>
    </Card>
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
    return <p className="py-2 text-xs text-muted-foreground">No tools discovered yet.</p>;
  }

  return (
    <div className="space-y-0">
      {server.discoveredTools.map((tool) => {
        const policyKey = `${server.id}:${tool.name}` as const;
        const policy = server.toolPolicies[policyKey] ?? 'alwaysAsk';

        return (
          <div key={tool.name} className="grid grid-cols-1 items-start gap-3 border-t border-border/60 py-2.5 sm:grid-cols-[1fr_150px]">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-[#f1f3f5] break-words">{tool.name}</p>
              <div className="mt-1 max-h-[80px] overflow-y-auto rounded-md border border-border/40 bg-muted/30 px-2 py-1.5">
                <p className="text-xs text-muted-foreground break-words leading-[17px]">{tool.description || 'No description provided.'}</p>
              </div>
            </div>
            <div className="pt-1">
              <Select
              value={policy}
              onValueChange={(nextPolicy) => {
                onChange({
                  ...server,
                  toolPolicies: {
                    ...server.toolPolicies,
                    [policyKey]: nextPolicy as AgentToolApprovalPolicy,
                  },
                });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="alwaysAsk">Always ask</SelectItem>
                <SelectItem value="alwaysAllow">Always allow</SelectItem>
                <SelectItem value="disabled">Disabled</SelectItem>
              </SelectContent>
            </Select>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SettingsPanel({ children }: { children: React.ReactNode }) {
  return <div className="max-w-[720px] space-y-0 border-t border-border/60">{children}</div>;
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
    <div className="grid grid-cols-1 items-center gap-2 border-b border-border/60 py-4 sm:grid-cols-[minmax(190px,0.75fr)_minmax(260px,1fr)] sm:gap-6">
      <span className="text-sm text-[#cbd1d6]">
        <strong className="block text-sm font-semibold text-[#f1f3f5]">{title}</strong>
        <small className="mt-0.5 block text-xs text-muted-foreground">{description}</small>
      </span>
      <div className="flex justify-start sm:justify-end">
        <Switch
          checked={checked}
          onCheckedChange={onChange}
          className={tone === 'agent' && checked ? 'data-[state=checked]:bg-agent data-[state=checked]:border-agent/70' : ''}
        />
      </div>
    </div>
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
    <div className="grid grid-cols-1 items-center gap-2 border-b border-border/60 py-4 sm:grid-cols-[minmax(190px,0.75fr)_minmax(260px,1fr)] sm:gap-6">
      <span className="text-sm text-[#cbd1d6]">{label}</span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
        {warning ? <small className="text-xs text-destructive break-words">{warning}</small> : null}
      </div>
    </div>
  );
}

function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-1 items-center gap-2 border-b border-border/60 py-4 sm:grid-cols-[minmax(190px,0.75fr)_minmax(260px,1fr)] sm:gap-6">
      <span className="text-sm text-[#cbd1d6]">{label}</span>
      <strong className="text-[13px] font-normal text-[#edf0f2] break-words">{value}</strong>
    </div>
  );
}

function KeyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-1 items-center gap-2 border-b border-border/60 py-4 sm:grid-cols-[minmax(190px,0.75fr)_minmax(260px,1fr)] sm:gap-6">
      <span className="text-sm text-[#cbd1d6]">{label}</span>
      <kbd className="w-fit rounded-md border border-border/60 bg-muted/50 px-2 py-1.5 font-mono text-[13px] text-[#edf0f2]">
        {value}
      </kbd>
    </div>
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
