import { useState } from 'react';
import type {
  AgentToolApprovalPolicy,
  McpServerConfig,
  McpServerRuntimeStatus,
} from '../../types/ipc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  createBlankMcpServer,
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
      <Card>
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
            <h3 className="text-base font-semibold">Configured MCPs</h3>
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
        <Label className="text-xs font-semibold text-muted-foreground">Name</Label>
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
        <Label htmlFor="mcp-enabled" className="text-sm text-muted-foreground">Enabled for Agent Mode</Label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-xs font-semibold text-muted-foreground">Transport</Label>
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
            <Label className="text-xs font-semibold text-muted-foreground">URL</Label>
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
              <Label className="text-xs font-semibold text-muted-foreground">Command</Label>
              <Input
                value={transport.command}
                placeholder="bun"
                onChange={(event) => onChange({ ...server, transport: { ...transport, command: event.target.value } })}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground">Arguments</Label>
              <Input
                value={transport.args.join(' ')}
                placeholder="run path/to/server.ts"
                onChange={(event) => onChange({ ...server, transport: { ...transport, args: splitList(event.target.value) } })}
              />
            </div>
            <div className="col-span-full space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground">Environment variable names</Label>
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
        <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground">OAuth client ID env var</Label>
              <Input
                value={transport.oauth.clientIdEnvVar ?? ''}
                placeholder="GOOGLE_CLIENT_ID"
                onChange={(event) => onChange({
                  ...server,
                  transport: {
                    ...transport,
                    oauth: { ...transport.oauth!, clientIdEnvVar: event.target.value },
                  },
                })}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground">OAuth client secret env var</Label>
              <Input
                value={transport.oauth.clientSecretEnvVar ?? ''}
                placeholder="GOOGLE_CLIENT_SECRET"
                onChange={(event) => onChange({
                  ...server,
                  transport: {
                    ...transport,
                    oauth: { ...transport.oauth!, clientSecretEnvVar: event.target.value },
                  },
                })}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Scopes</span>
            <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-primary">gmail.readonly</code>
            <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-primary">gmail.compose</code>
          </div>
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
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold break-words">{server.displayName || 'Unnamed MCP Server'}</p>
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
            Reconnect / Test
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
          <div key={tool.name} className="grid grid-cols-1 items-start gap-3 border-t border-border py-2.5 sm:grid-cols-[1fr_150px]">
            <div className="min-w-0">
              <p className="text-sm font-semibold break-words">{tool.name}</p>
              <div className="mt-1 max-h-20 overflow-y-auto rounded-md border border-border/40 bg-muted/30 px-2 py-1.5">
                <p className="text-xs text-muted-foreground break-words leading-relaxed">{tool.description || 'No description provided.'}</p>
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
