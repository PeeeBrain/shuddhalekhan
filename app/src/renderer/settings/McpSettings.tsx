import { useState } from 'react';
import { Plug } from 'lucide-react';
import type {
  AgentToolApprovalPolicy,
  McpServerConfig,
  McpServerRuntimeStatus,
} from '../../types/ipc';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { SectionHeader, SettingsPanel, SettingsPanelHeader } from './ui/SectionHeader';
import { Tag } from './ui/rows';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  createBlankMcpServer,
  createHttpMcpTransport,
  formatTransport,
  normalizeDraftServer,
  splitCommaList,
  splitList,
} from './mcp-settings-model';

export function McpSettings({
  servers,
  statuses,
  onChange,
  onTest,
  saveError,
}: {
  servers: McpServerConfig[];
  statuses: Record<string, McpServerRuntimeStatus>;
  onChange: (servers: McpServerConfig[]) => void;
  onTest: (serverId: string) => void;
  saveError?: string;
}) {
  const [draft, setDraft] = useState<McpServerConfig>(() => createBlankMcpServer());
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<McpServerConfig | null>(null);

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
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Agent tools"
        title="MCP Servers"
        description="Connect Agent Mode to local or remote Model Context Protocol servers."
      />
      {saveError ? (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {saveError}
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)]">
        <SettingsPanel
          aria-label={editingServerId ? 'Edit MCP Server' : 'Add MCP Server'}
          className="overflow-hidden"
        >
          <SettingsPanelHeader
            eyebrow="Connection"
            title={editingServerId ? 'Edit MCP Server' : 'Add MCP Server'}
            description="Configure one server, save it, then test discovery from the configured list."
          />
          <div className="space-y-5">
            <McpServerForm server={draft} onChange={setDraft} />
            <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-5">
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
          </div>
        </SettingsPanel>

        <SettingsPanel aria-labelledby="configured-mcp-heading" className="overflow-hidden">
          <SettingsPanelHeader
            id="configured-mcp-heading"
            eyebrow="Registry"
            title="Configured MCPs"
            description={
              servers.length === 0
                ? 'Add a server to give Agent Mode tools.'
                : `${servers.length} server${servers.length === 1 ? '' : 's'} configured.`
            }
            actions={<Tag tone={servers.length > 0 ? 'agent' : 'neutral'}>{servers.length}</Tag>}
          />
          <div className="p-6">
            {servers.length === 0 ? (
              <div className="settings-panel-muted flex min-h-44 flex-col items-center justify-center px-6 text-center">
                <span className="mb-3 flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Plug className="size-5" aria-hidden="true" />
                </span>
                <p className="text-sm font-semibold">No MCP servers configured.</p>
                <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
                  Saved servers will appear here with live connection status and tool policies.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {servers.map((server) => (
                  <ConfiguredMcpServer
                    key={server.id}
                    server={server}
                    status={statuses[server.id]}
                    onEdit={() => {
                      setDraft(server);
                      setEditingServerId(server.id);
                    }}
                    onRemove={() => setRemoveTarget(server)}
                    onTest={() => onTest(server.id)}
                    onPolicyChange={(nextServer) => {
                      onChange(servers.map((item) => (item.id === server.id ? nextServer : item)));
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </SettingsPanel>
      </div>

      <ConfirmDialog
        open={removeTarget !== null}
        title={`Remove "${removeTarget?.displayName || 'Unnamed MCP Server'}"?`}
        description="Per-tool approval policies for this server will be lost. This action cannot be undone."
        confirmLabel="Remove"
        onConfirm={() => {
          if (removeTarget) removeServer(removeTarget.id);
          setRemoveTarget(null);
        }}
        onCancel={() => setRemoveTarget(null)}
      />
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
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="mcp-name" className="text-sm font-medium">Name</Label>
        <Input
          id="mcp-name"
          aria-label="Name"
          className="h-10"
          value={server.displayName}
          onChange={(event) => onChange({ ...server, displayName: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">Use a name you will recognize when the agent connects.</p>
      </div>

      <div className="settings-panel-muted flex items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <Label htmlFor="mcp-enabled" className="text-sm font-medium">Enabled for Agent Mode</Label>
          <p className="mt-1 text-xs text-muted-foreground">Disabled servers stay saved but are not connected.</p>
        </div>
        <Switch
          id="mcp-enabled"
          checked={server.enabled}
          onCheckedChange={(checked) => onChange({ ...server, enabled: checked })}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="mcp-transport" className="text-sm font-medium">Transport</Label>
          <Select
            value={server.transport.type}
            onValueChange={(type) => {
              onChange({
                ...server,
                transport:
                  type === 'http'
                    ? createHttpMcpTransport()
                    : { type: 'stdio', command: '', args: [], envVarNames: [] },
              });
            }}
          >
            <SelectTrigger id="mcp-transport" aria-label="Transport" className="h-10 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">stdio</SelectItem>
              <SelectItem value="http">HTTP</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {transport.type === 'http' ? (
          <>
            <div className="col-span-full space-y-2">
              <Label htmlFor="mcp-url" className="text-sm font-medium">URL</Label>
              <Input
                id="mcp-url"
                aria-label="URL"
                className="h-10"
                value={transport.url}
                placeholder="http://localhost:3000/mcp"
                onChange={(event) => onChange({ ...server, transport: { ...transport, url: event.target.value } })}
              />
            </div>
            <div className="col-span-full settings-panel-muted px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="mcp-follow-redirects" className="text-sm font-medium">
                  Follow HTTP redirects
                </Label>
                <Switch
                  id="mcp-follow-redirects"
                  checked={transport.redirect === 'follow'}
                  onCheckedChange={(checked) => onChange({
                    ...server,
                    transport: { ...transport, redirect: checked ? 'follow' : 'error' },
                  })}
                />
              </div>
              <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted-foreground">
                Off by default. Enable only when this server requires redirects and you trust its destination.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="mcp-command" className="text-sm font-medium">Command</Label>
              <Input
                id="mcp-command"
                aria-label="Command"
                className="h-10"
                value={transport.command}
                placeholder="bun"
                onChange={(event) => onChange({ ...server, transport: { ...transport, command: event.target.value } })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-arguments" className="text-sm font-medium">Arguments</Label>
              <Input
                id="mcp-arguments"
                aria-label="Arguments"
                className="h-10"
                value={transport.args.join(' ')}
                placeholder="run path/to/server.ts"
                onChange={(event) => onChange({ ...server, transport: { ...transport, args: splitList(event.target.value) } })}
              />
            </div>
            <div className="col-span-full space-y-2">
              <Label htmlFor="mcp-env-vars" className="text-sm font-medium">Environment variable names</Label>
              <Input
                id="mcp-env-vars"
                aria-label="Environment variable names"
                className="h-10"
                value={transport.envVarNames.join(', ')}
                placeholder="GITHUB_TOKEN, MY_API_KEY"
                onChange={(event) => onChange({ ...server, transport: { ...transport, envVarNames: splitCommaList(event.target.value) } })}
              />
              <p className="text-xs text-muted-foreground">Names only. Secret values stay in the environment.</p>
            </div>
          </>
        )}
      </div>
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
  const statusTone = status?.status === 'connected'
    ? 'success'
    : status?.status === 'connecting'
      ? 'info'
      : status?.status === 'failed'
        ? 'error'
        : 'neutral';
  const statusDotClass = status?.status === 'connected'
    ? 'bg-success'
    : status?.status === 'connecting'
      ? 'bg-primary'
      : status?.status === 'failed'
        ? 'bg-destructive'
        : 'bg-muted-foreground/50';

  return (
    <article className="settings-panel-muted space-y-4 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className={`mt-1.5 size-2 shrink-0 rounded-full ${statusDotClass}`} aria-hidden="true" />
          <div className="min-w-0">
            <p className="break-words text-sm font-semibold">{server.displayName || 'Unnamed MCP Server'}</p>
            <p className="mt-1 break-words text-xs text-muted-foreground">{formatTransport(server)}</p>
          </div>
        </div>
        <Tag tone={statusTone}>{status?.status ?? 'not tested'}</Tag>
      </div>

      <div className="flex flex-wrap gap-2">
        <Tag tone={server.enabled ? 'agent' : 'neutral'}>
          {server.enabled ? 'Enabled for Agent Mode' : 'Disabled'}
        </Tag>
        <Tag>
          {server.discoveredTools.length} tool{server.discoveredTools.length === 1 ? '' : 's'}
        </Tag>
      </div>

      {status?.message ? (
        <p role="alert" className="break-words rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
          {status.message}
        </p>
      ) : null}

      <ToolPolicyEditor server={server} onChange={onPolicyChange} />

      <div className="flex flex-wrap justify-end gap-2 border-t border-border/50 pt-4">
        <Button type="button" variant="secondary" size="sm" onClick={onTest}>
          Reconnect / Test
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </article>
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
    return (
      <div className="rounded-lg border border-dashed border-border/70 px-4 py-4">
        <p className="text-sm font-medium">No tools discovered yet.</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Reconnect the server after it is running to discover its available tools.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Tool policies</p>
        <p className="mt-1 text-xs text-muted-foreground">Choose how much freedom the agent has with each tool.</p>
      </div>
      <div className="divide-y divide-border/50 rounded-lg border border-border/50 bg-background/30 px-4">
        {server.discoveredTools.map((tool) => {
          const policyKey = `${server.id}:${tool.name}` as const;
          const policy = server.toolPolicies[policyKey] ?? 'alwaysAsk';

          return (
            <div key={tool.name} className="grid grid-cols-1 items-start gap-3 py-4 sm:grid-cols-[1fr_160px]">
              <div className="min-w-0">
                <p className="break-words text-sm font-semibold">{tool.name}</p>
                <div className="mt-2 max-h-20 overflow-y-auto rounded-md border border-border/40 bg-muted/20 px-3 py-2">
                  <p className="break-words text-xs leading-relaxed text-muted-foreground">{tool.description || 'No description provided.'}</p>
                </div>
              </div>
              <div className="pt-0.5">
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
                  <SelectTrigger aria-label={`Approval policy for ${tool.name}`} className="h-9 w-full">
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
    </div>
  );
}
