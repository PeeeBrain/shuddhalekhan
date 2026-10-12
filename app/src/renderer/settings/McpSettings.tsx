import { useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
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
import { SectionHeader, SettingsCard } from './ui/SectionHeader';
import { Tag, type TagTone } from './ui/rows';
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
  // null = form closed, 'new' = adding, otherwise the id being edited.
  const [formTarget, setFormTarget] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<McpServerConfig | null>(null);
  const editingServerId = formTarget === 'new' ? null : formTarget;

  const openForm = (server?: McpServerConfig) => {
    setDraft(server ?? createBlankMcpServer());
    setFormTarget(server?.id ?? 'new');
  };

  const closeForm = () => {
    setDraft(createBlankMcpServer());
    setFormTarget(null);
  };

  const saveDraft = () => {
    const server = normalizeDraftServer(draft, editingServerId);
    if (editingServerId) {
      onChange(servers.map((item) => (item.id === editingServerId ? { ...server, id: editingServerId } : item)));
    } else {
      onChange([...servers, server]);
    }
    closeForm();
  };

  const removeServer = (serverId: string) => {
    onChange(servers.filter((server) => server.id !== serverId));
    if (editingServerId === serverId) closeForm();
  };

  return (
    <div className="space-y-8">
      <SectionHeader
        title="MCP Servers"
        description="Give Agent Mode tools from local or remote Model Context Protocol servers."
        actions={formTarget === null ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => openForm()}>
            <Plus aria-hidden="true" />
            Add server
          </Button>
        ) : null}
      />
      {saveError ? (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {saveError}
        </div>
      ) : null}

      {formTarget !== null ? (
        <section aria-label={editingServerId ? 'Edit MCP Server' : 'Add MCP Server'} className="settings-panel">
          <h3 className="px-1 text-[13px] font-medium text-muted-foreground">
            {editingServerId ? 'Edit MCP Server' : 'Add MCP Server'}
          </h3>
          <SettingsCard className="space-y-5 py-4">
            <McpServerForm server={draft} onChange={setDraft} />
            <div className="flex flex-wrap justify-end gap-2 border-t border-border/50 pt-4">
              <Button type="button" variant="ghost" size="sm" onClick={closeForm}>
                {editingServerId ? 'Cancel Edit' : 'Cancel'}
              </Button>
              <Button type="button" size="sm" onClick={saveDraft}>
                {editingServerId ? 'Save Changes' : 'Save Server'}
              </Button>
            </div>
          </SettingsCard>
        </section>
      ) : null}

      <section aria-labelledby="configured-mcp-heading" className="settings-panel">
        <div className="flex items-baseline justify-between gap-4 px-1">
          <h3 id="configured-mcp-heading" className="text-[13px] font-medium text-muted-foreground">Configured servers</h3>
          <p className="text-xs text-muted-foreground">
            {servers.length === 0 ? 'None yet' : `${servers.length} configured`}
          </p>
        </div>
        {servers.length === 0 ? (
          <SettingsCard className="py-8 text-center text-sm text-muted-foreground">
            No servers yet. Add one to give Agent Mode tools.
          </SettingsCard>
        ) : (
          <div className="space-y-3">
            {servers.map((server) => (
              <ConfiguredMcpServer
                key={server.id}
                server={server}
                status={statuses[server.id]}
                canReconnect={agentEnabled && server.enabled}
                onEdit={() => openForm(server)}
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
          className="h-9"
          value={server.displayName}
          onChange={(event) => onChange({ ...server, displayName: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">Use a name you will recognize when the agent connects.</p>
      </div>

      <div className="settings-panel-muted flex items-center justify-between gap-4">
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
            <SelectTrigger id="mcp-transport" aria-label="Transport" className="h-9 w-full">
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
                className="h-9"
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
                className="h-9"
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
                    className="h-9"
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
                    className="h-9"
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
                className="h-9"
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
                className="h-9"
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
                className="h-9"
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
  const statusTone: TagTone = !server.enabled || !status
    ? 'neutral'
    : status.status === 'connected'
      ? 'success'
      : status.status === 'connecting'
        ? 'info'
        : 'error';

  return (
    <SettingsCard className="space-y-3 py-3.5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="break-words text-sm font-medium">{server.displayName || 'Unnamed MCP Server'}</p>
            <Tag tone={statusTone} className="capitalize">{statusLabel}</Tag>
          </div>
          <p className="mt-0.5 break-words font-mono text-xs text-muted-foreground">{formatTransport(server)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onTest}
            disabled={!canReconnect}
            title={!canReconnect ? 'Enable Agent Mode and this server to reconnect.' : undefined}
          >
            Reconnect
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onRemove}
          >
            Remove
          </Button>
        </div>
      </div>

      {status?.message ? (
        <p role="alert" className="break-words text-xs leading-5 text-destructive">
          {status.message}
        </p>
      ) : null}

      <ToolPolicyEditor server={server} onChange={onPolicyChange} />
    </SettingsCard>
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
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="text-xs font-medium">
          Tools · {server.discoveredTools.length}
        </span>
        <ChevronDown aria-hidden="true" className={`size-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div className="divide-y divide-border/50 border-t border-border/50">
        {server.discoveredTools.map((tool) => {
          const policyKey = `${server.id}:${tool.name}` as const;
          const policy = server.toolPolicies[policyKey] ?? 'alwaysAsk';

          return (
            <div key={tool.name} className="grid grid-cols-1 items-start gap-3 py-3 sm:grid-cols-[1fr_160px]">
              <div className="min-w-0">
                <p className="break-words font-mono text-[13px] font-medium">{tool.name}</p>
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
                  <SelectTrigger aria-label={`Approval policy for ${tool.name}`} className="h-8 w-full">
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
