import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type {
  AgentToolApprovalPolicy,
  McpHttpOAuthConfig,
  McpServerConfig,
  McpServerRuntimeStatus,
} from '../../types/ipc';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { SectionHeader, SettingsPanel, SettingsPanelHeader } from './ui/SectionHeader';
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
  agentEnabled,
  onChange,
  onTest,
  saveError,
}: {
  servers: McpServerConfig[];
  statuses: Record<string, McpServerRuntimeStatus>;
  agentEnabled: boolean;
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
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)]">
        <SettingsPanel
          aria-label={editingServerId ? 'Edit MCP Server' : 'Add MCP Server'}
          className="overflow-hidden [scrollbar-gutter:stable] lg:sticky lg:top-8 lg:max-h-[calc(100dvh-4rem)] lg:overflow-y-auto lg:self-start"
        >
          <SettingsPanelHeader
            eyebrow="Connection"
            title={editingServerId ? 'Edit MCP Server' : 'Add MCP Server'}
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

        <section aria-labelledby="configured-mcp-heading" className="space-y-3">
          <div className="flex items-baseline justify-between gap-4 px-1">
            <h3 id="configured-mcp-heading" className="text-sm font-semibold">Configured servers</h3>
            <p className="text-xs text-muted-foreground">
              {servers.length === 0 ? 'None yet' : `${servers.length} configured`}
            </p>
          </div>
          {servers.length === 0 ? (
            <p className="px-1 text-sm leading-6 text-muted-foreground">
              No MCP servers configured yet. Add one on the left to give Agent Mode tools.
            </p>
          ) : (
            <div className="space-y-4">
              {servers.map((server) => (
                <ConfiguredMcpServer
                  key={server.id}
                  server={server}
                  status={statuses[server.id]}
                  canReconnect={agentEnabled && server.enabled}
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
        </section>
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

  const updateOauth = (patch: Partial<McpHttpOAuthConfig>) => {
    if (transport.type !== 'http') return;
    const oauth: McpHttpOAuthConfig = {
      clientId: transport.oauth?.clientId ?? '',
      clientSecretEnvVar: transport.oauth?.clientSecretEnvVar ?? '',
      scopes: transport.oauth?.scopes ?? [],
      ...patch,
    };
    onChange({
      ...server,
      transport: { ...transport, oauth },
    });
  };

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
            <div className="col-span-full space-y-2">
              <Label htmlFor="mcp-oauth-client-id" className="text-sm font-medium">OAuth client ID</Label>
              <Input
                id="mcp-oauth-client-id"
                aria-label="OAuth client ID"
                className="h-10"
                value={transport.oauth?.clientId ?? ''}
                placeholder="Optional, e.g. a pre-registered Google OAuth client"
                onChange={(event) => updateOauth({ clientId: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                For OAuth servers that don&apos;t register clients for you (for example Google). Leave empty otherwise.
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="mcp-oauth-secret-env" className="text-sm font-medium">Client secret env var name</Label>
                  <Input
                    id="mcp-oauth-secret-env"
                    aria-label="Client secret env var name"
                    className="h-10"
                    value={transport.oauth?.clientSecretEnvVar ?? ''}
                    placeholder="GOOGLE_OAUTH_CLIENT_SECRET"
                    onChange={(event) => updateOauth({ clientSecretEnvVar: event.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">Names only. Secret values stay in the environment.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mcp-oauth-scopes" className="text-sm font-medium">OAuth scopes</Label>
                  <Input
                    id="mcp-oauth-scopes"
                    aria-label="OAuth scopes"
                    className="h-10"
                    value={transport.oauth?.scopes.join(',') ?? ''}
                    placeholder="https://mail.google.com/, ..."
                    onChange={(event) => updateOauth({ scopes: event.target.value.split(',') })}
                  />
                </div>
              </div>
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
  canReconnect,
  onEdit,
  onRemove,
  onTest,
  onPolicyChange,
}: {
  server: McpServerConfig;
  status?: McpServerRuntimeStatus;
  canReconnect: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onTest: () => void;
  onPolicyChange: (server: McpServerConfig) => void;
}) {
  const statusLabel = !server.enabled ? 'disabled' : status?.status ?? 'not tested';
  const statusTextClass = !server.enabled || !status
    ? 'text-muted-foreground'
    : status.status === 'connected'
      ? 'text-success'
      : status.status === 'connecting'
        ? 'text-primary'
        : 'text-destructive';
  const statusDotClass = !server.enabled || !status
    ? 'bg-muted-foreground/50'
    : status.status === 'connected'
      ? 'bg-success'
      : status.status === 'connecting'
        ? 'bg-primary'
        : 'bg-destructive';

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
        <span className={`shrink-0 text-xs font-medium capitalize ${statusTextClass}`}>{statusLabel}</span>
      </div>

      {status?.message ? (
        <p role="alert" className="break-words text-xs leading-5 text-destructive">
          {status.message}
        </p>
      ) : null}

      <ToolPolicyEditor server={server} onChange={onPolicyChange} />

      <div className="flex flex-wrap justify-end gap-2 border-t border-border/50 pt-4">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onTest}
          disabled={!canReconnect}
          title={!canReconnect ? 'Enable Agent Mode and this server to reconnect.' : undefined}
        >
          Reconnect
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
  const [open, setOpen] = useState(false);

  if (server.discoveredTools.length === 0) {
    return (
      <p className="text-xs leading-5 text-muted-foreground">
        No tools discovered yet. Reconnect the server once it is running.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/30 px-4 py-3 text-left hover:bg-muted/40"
      >
        <span className="text-sm font-medium">
          Tools <span className="text-muted-foreground">· {server.discoveredTools.length}</span>
        </span>
        <ChevronDown aria-hidden="true" className={`size-4 shrink-0 text-muted-foreground ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div className="divide-y divide-border/50">
        {server.discoveredTools.map((tool) => {
          const policyKey = `${server.id}:${tool.name}` as const;
          const policy = server.toolPolicies[policyKey] ?? 'alwaysAsk';

          return (
            <div key={tool.name} className="grid grid-cols-1 items-start gap-3 py-3 sm:grid-cols-[1fr_160px]">
              <div className="min-w-0">
                <p className="break-words text-sm font-semibold">{tool.name}</p>
                <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                  {tool.description || 'No description provided.'}
                </p>
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
      ) : null}
    </div>
  );
}
