# Remove MCP Presets and Client OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all MCP presets, Gmail-specific behavior, and Shuddhalekhan-owned MCP-client OAuth while keeping generic HTTP and stdio MCP servers working.

**Architecture:** Shuddhalekhan v4 keeps a generic MCP registry only: users add HTTP or stdio servers and the sidecar connects/discovers tools. Hosted MCP servers may manage their own downstream OAuth internally, but Shuddhalekhan will not perform OAuth as the MCP client. The cleanup removes misleading persisted config shape, dead OAuth protocol/runtime code, preset UI affordances, and stale docs/tests.

**Tech Stack:** Electron main/preload, React settings UI, TypeScript, Bun tests, Vercel AI SDK `@ai-sdk/mcp`.

---

## Source Decisions

- `CONTEXT.md` now defines v4 MCP registry as generic-only.
- `docs/adr/0002-remove-gmail-mcp-preset-and-defer-client-oauth.md` records the architecture decision.
- Do not run build commands. Use only `bun run lint`, `bun run typecheck`, and targeted/full `bun test`.

## File Structure

- Modify `src/types/ipc.ts`: remove `transport.oauth` and `McpServerConfig.preset`.
- Modify `src/agent/mcp-server-config.ts`: remove preset deduplication; keep tool policy normalization.
- Modify `src/agent/mcp-registry.ts`: remove `SidecarOAuthProvider`, `authProvider`, and provider close handling.
- Delete `src/agent/oauth-provider.ts`: no current code should import it.
- Modify `src/agent/protocol.ts`: remove `OAuthOpenUrlEvent` and the `oauth:open-url` union member.
- Modify `src/main/sidecar-event-router.ts`: remove `openExternal` dependency and `oauth:open-url` handler.
- Modify `src/renderer/settings/McpSettings.tsx`: remove Add Gmail Preset button, preset locking, OAuth fields, and Gmail scope copy.
- Modify tests under `src/**/__tests__/`: replace Gmail/preset assertions with generic HTTP server assertions and remove OAuth event tests.
- Modify `docs/agent-mode-implementation-plan.md` and `README.md`: remove preset/client-OAuth claims and describe generic hosted MCP servers.
- Do not modify `package.json` version or `release-notes.md` unless this plan is being executed as a release-prep task.

---

### Task 1: Remove Preset and OAuth Config Types

**Files:**
- Modify: `src/types/ipc.ts`
- Modify: `src/agent/mcp-server-config.ts`
- Test: `src/agent/__tests__/mcp-server-config.test.ts`
- Test: `src/main/__tests__/config.test.ts`

- [ ] **Step 1: Write failing tests for generic-only normalization**

Replace the Gmail/preset-specific test in `src/agent/__tests__/mcp-server-config.test.ts` with this generic duplicate-preserving test:

```ts
it('keeps multiple generic HTTP servers and existing tool policies', () => {
  const servers = normalizeMcpServers([
    {
      id: 'mail-primary',
      displayName: 'Hosted Mail',
      enabled: true,
      transport: { type: 'http', url: 'https://mail.example.com/mcp' },
      discoveredTools: [{ name: 'read_email', description: 'Read email', discoveredAt: '2026-05-11T00:00:00.000Z' }],
      toolPolicies: { 'mail-primary:read_email': 'alwaysAllow' },
    },
    {
      id: 'mail-secondary',
      displayName: 'Hosted Mail Second Account',
      enabled: true,
      transport: { type: 'http', url: 'https://mail2.example.com/mcp' },
      discoveredTools: [],
      toolPolicies: {},
    },
  ]);

  expect(servers).toHaveLength(2);
  expect(servers[0].toolPolicies).toEqual({
    'mail-primary:read_email': 'alwaysAllow',
  });
  expect(servers[1].id).toBe('mail-secondary');
});
```

In `src/main/__tests__/config.test.ts`, rename the test `defaults newly discovered MCP tools to alwaysAsk and keeps one Gmail preset` to `defaults newly discovered MCP tools to alwaysAsk for generic MCP servers`, and replace the `mcpServers` fixture with:

```ts
mcpServers: [
  {
    id: 'mail-primary',
    displayName: 'Hosted Mail',
    enabled: true,
    transport: {
      type: 'http',
      url: 'https://mail.example.com/mcp',
    },
    discoveredTools: [
      {
        name: 'draft_email',
        description: 'Draft an email',
        discoveredAt: '2026-05-07T00:00:00.000Z',
      },
    ],
    toolPolicies: {},
  },
  {
    id: 'mail-secondary',
    displayName: 'Hosted Mail Second Account',
    enabled: true,
    transport: {
      type: 'http',
      url: 'https://mail2.example.com/mcp',
    },
    discoveredTools: [],
    toolPolicies: {},
  },
],
```

Replace the expectation with:

```ts
expect(getConfig().agent.mcpServers).toEqual([
  {
    id: 'mail-primary',
    displayName: 'Hosted Mail',
    enabled: true,
    transport: {
      type: 'http',
      url: 'https://mail.example.com/mcp',
    },
    discoveredTools: [
      {
        name: 'draft_email',
        description: 'Draft an email',
        discoveredAt: '2026-05-07T00:00:00.000Z',
      },
    ],
    toolPolicies: {
      'mail-primary:draft_email': 'alwaysAsk',
    },
  },
  {
    id: 'mail-secondary',
    displayName: 'Hosted Mail Second Account',
    enabled: true,
    transport: {
      type: 'http',
      url: 'https://mail2.example.com/mcp',
    },
    discoveredTools: [],
    toolPolicies: {},
  },
]);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
bun test src/agent/__tests__/mcp-server-config.test.ts src/main/__tests__/config.test.ts
```

Expected: FAIL because current normalization removes duplicate `preset: 'gmail'` only after the test still imports types with obsolete preset/oauth shape, or because the old code/tests still expect Gmail-specific behavior.

- [ ] **Step 3: Remove obsolete type fields**

In `src/types/ipc.ts`, replace the HTTP transport branch with:

```ts
  | {
      type: 'http';
      url: string;
    };
```

Remove this field from `McpServerConfig`:

```ts
  preset?: 'gmail';
```

- [ ] **Step 4: Simplify MCP server normalization**

In `src/agent/mcp-server-config.ts`, replace `normalizeMcpServers` with:

```ts
export function normalizeMcpServers(servers: McpServerConfig[] | undefined): McpServerConfig[] {
  if (!Array.isArray(servers)) return [];

  return servers.map(normalizeMcpServer);
}
```

- [ ] **Step 5: Run the targeted tests again**

Run:

```powershell
bun test src/agent/__tests__/mcp-server-config.test.ts src/main/__tests__/config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/types/ipc.ts src/agent/mcp-server-config.ts src/agent/__tests__/mcp-server-config.test.ts src/main/__tests__/config.test.ts
git commit -m "refactor: remove mcp preset config shape"
```

---

### Task 2: Remove Sidecar Client-OAuth Runtime and Protocol

**Files:**
- Modify: `src/agent/mcp-registry.ts`
- Delete: `src/agent/oauth-provider.ts`
- Modify: `src/agent/protocol.ts`
- Modify: `src/main/sidecar-event-router.ts`
- Test: `src/agent/__tests__/mcp-registry.test.ts`
- Test: `src/main/__tests__/sidecar-event-router.test.ts`

- [ ] **Step 1: Write failing registry assertion for plain HTTP transport**

In `src/agent/__tests__/mcp-registry.test.ts`, in `connects enabled servers and creates namespaced tool snapshots`, add this assertion after `await registry.updateConfig(...)`:

```ts
expect(createMCPClientMock).toHaveBeenCalledWith({
  transport: {
    type: 'http',
    url: 'http://localhost:3000/mcp',
  },
});
```

This asserts that HTTP MCP connection uses no `authProvider`.

- [ ] **Step 2: Remove OAuth event test**

In `src/main/__tests__/sidecar-event-router.test.ts`, delete the whole test named `opens OAuth URLs externally`.

Also remove `openExternal` from the router setup if it becomes unused in the test file.

- [ ] **Step 3: Run tests to verify current runtime still exposes obsolete OAuth wiring**

Run:

```powershell
bun test src/agent/__tests__/mcp-registry.test.ts src/main/__tests__/sidecar-event-router.test.ts
```

Expected: FAIL in `mcp-registry.test.ts` because current HTTP transport includes `authProvider: undefined`, or TypeScript/lint later fails because OAuth protocol/router code is still present.

- [ ] **Step 4: Remove OAuth provider wiring from registry**

In `src/agent/mcp-registry.ts`, delete:

```ts
import { SidecarOAuthProvider } from './oauth-provider';
```

Change `ManagedServer` to:

```ts
type ManagedServer = {
  config: McpServerConfig;
  client: MCPClient;
  rawTools: Record<string, Tool>;
};
```

In `connect`, remove all `oauthProvider` code. The method should create the client like this:

```ts
const client = await createMCPClient({ transport: createTransport(server) });
const rawTools = (await client.tools()) as Record<string, Tool>;
this.servers.set(server.id, { config: server, client, rawTools });
```

Remove this line from the `catch` block:

```ts
oauthProvider?.close();
```

Remove this line from `disconnect`:

```ts
server.oauthProvider?.close();
```

Replace `createTransport` with:

```ts
function createTransport(server: McpServerConfig) {
  if (server.transport.type === 'stdio') {
    const env: Record<string, string> = {};
    for (const name of server.transport.envVarNames) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return new Experimental_StdioMCPTransport({
      command: server.transport.command,
      args: server.transport.args,
      env,
    });
  }

  return {
    type: 'http' as const,
    url: server.transport.url,
  };
}
```

Delete the `createOAuthProvider` function.

- [ ] **Step 5: Remove OAuth protocol event**

In `src/agent/protocol.ts`, delete:

```ts
export type OAuthOpenUrlEvent = {
  type: 'oauth:open-url';
  serverId: string;
  url: string;
};
```

Remove `| OAuthOpenUrlEvent` from `SidecarEvent`.

- [ ] **Step 6: Remove OAuth router handling**

In `src/main/sidecar-event-router.ts`, remove this dependency field:

```ts
  openExternal: (url: string) => Promise<unknown>;
```

Delete this handler:

```ts
'oauth:open-url': (event) => {
  deps.openExternal(event.url).catch((err) => {
    console.error(`Failed to open OAuth URL for ${event.serverId}:`, err);
  });
},
```

Then update all `createSidecarEventRouter` call sites/tests to stop passing `openExternal`. Use `rg -n "openExternal|oauth:open-url" src` to find all remaining references.

- [ ] **Step 7: Delete the OAuth provider file**

Delete `src/agent/oauth-provider.ts`.

- [ ] **Step 8: Run targeted tests**

Run:

```powershell
bun test src/agent/__tests__/mcp-registry.test.ts src/main/__tests__/sidecar-event-router.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add src/agent/mcp-registry.ts src/agent/protocol.ts src/main/sidecar-event-router.ts src/agent/__tests__/mcp-registry.test.ts src/main/__tests__/sidecar-event-router.test.ts
git add -u src/agent/oauth-provider.ts
git commit -m "refactor: remove mcp client oauth runtime"
```

---

### Task 3: Remove Preset and OAuth UI

**Files:**
- Modify: `src/renderer/settings/McpSettings.tsx`
- Test: `src/renderer/settings/__tests__/mcp-settings-model.test.ts`
- Test: add or modify renderer settings component tests only if an existing test harness for `McpSettings` exists; otherwise use typecheck and lint as coverage for this UI cleanup.

- [ ] **Step 1: Confirm there is no existing component test**

Run:

```powershell
rg -n "render\\(<McpSettings|Add Gmail Preset|McpSettings" src/renderer/settings src/renderer -g "*test.ts*" -g "*test.tsx"
```

Expected: likely only model/settings IPC tests exist. If a `McpSettings` component test exists, update it in the next steps. If none exists, do not add a new React test harness just for deleting UI; rely on typecheck/lint.

- [ ] **Step 2: Remove Add Gmail Preset code**

In `src/renderer/settings/McpSettings.tsx`, delete the `addGmailPreset` function entirely.

Replace the `CardHeader` top block with:

```tsx
<CardHeader>
  <CardTitle className="text-base">{editingServerId ? 'Edit MCP Server' : 'Add MCP Server'}</CardTitle>
  <CardDescription>Configure one server, save it, then test discovery from the configured list.</CardDescription>
</CardHeader>
```

- [ ] **Step 3: Remove preset locks from transport inputs**

In the transport `Select`, remove:

```tsx
disabled={server.preset === 'gmail'}
```

In the HTTP URL `Input`, remove:

```tsx
disabled={server.preset === 'gmail'}
```

- [ ] **Step 4: Remove OAuth field panel**

Delete the whole block:

```tsx
{transport.type === 'http' && transport.oauth?.enabled ? (
  <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3">
    ...
  </div>
) : null}
```

This removes OAuth client env-var fields and Gmail scope badges.

- [ ] **Step 5: Check UI file for stale strings**

Run:

```powershell
rg -n "gmail|Gmail|preset|oauth|OAuth|GOOGLE_CLIENT|gmail\\.readonly|gmail\\.compose" src/renderer/settings/McpSettings.tsx
```

Expected: no matches.

- [ ] **Step 6: Run renderer settings tests and typecheck**

Run:

```powershell
bun test src/renderer/settings/__tests__/mcp-settings-model.test.ts src/renderer/settings/__tests__/settings-ipc.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/renderer/settings/McpSettings.tsx src/renderer/settings/__tests__/mcp-settings-model.test.ts src/renderer/settings/__tests__/settings-ipc.test.ts
git commit -m "refactor: remove mcp preset settings ui"
```

---

### Task 4: Update Remaining Tests and Generic Naming

**Files:**
- Modify: `src/main/__tests__/sidecar-config-policy.test.ts`
- Modify: `src/main/__tests__/sidecar-event-router.test.ts`
- Modify any file found by stale search under `src/**/__tests__`

- [ ] **Step 1: Find stale Gmail/OAuth test names**

Run:

```powershell
rg -n "gmail|Gmail|preset|oauth|OAuth|gmailmcp|GOOGLE_CLIENT" src -g "*test.ts" -g "*test.tsx"
```

Expected before cleanup: matches in several tests.

- [ ] **Step 2: Rename generic test fixtures**

For tests that use `id: 'gmail'` only as a sample server, rename to generic values:

```ts
id: 'mail'
displayName: 'Hosted Mail'
transport: { type: 'http', url: 'https://mail.example.com/mcp' }
```

Update expected policy keys from:

```ts
'gmail:read_email'
```

to:

```ts
'mail:read_email'
```

Update model-facing tool names from:

```ts
gmail__send_email
```

to:

```ts
mail__send_email
```

Update status strings from:

```ts
Checking Gmail
```

to:

```ts
Checking mail
```

- [ ] **Step 3: Run all affected tests**

Run:

```powershell
bun test src/main/__tests__/sidecar-config-policy.test.ts src/main/__tests__/sidecar-event-router.test.ts src/main/__tests__/config.test.ts src/agent/__tests__/mcp-server-config.test.ts
```

Expected: PASS.

- [ ] **Step 4: Confirm source tree has no stale product Gmail/OAuth code**

Run:

```powershell
rg -n "preset|transport\\.oauth|oauth:open-url|SidecarOAuthProvider|gmailmcp|GOOGLE_CLIENT|gmail\\.readonly|gmail\\.compose" src
```

Expected: no matches.

Run:

```powershell
rg -n "gmail|Gmail" src
```

Expected: only acceptable generic sample strings if a test deliberately models a user-provided Gmail-capable server. Prefer zero matches in `src` after this cleanup.

- [ ] **Step 5: Commit**

```powershell
git add src/main/__tests__/sidecar-config-policy.test.ts src/main/__tests__/sidecar-event-router.test.ts src/main/__tests__/config.test.ts src/agent/__tests__/mcp-server-config.test.ts
git commit -m "test: use generic mcp server fixtures"
```

---

### Task 5: Update Project Documentation

**Files:**
- Modify: `docs/agent-mode-implementation-plan.md`
- Modify: `README.md`
- Already modified: `CONTEXT.md`
- Already added: `docs/adr/0002-remove-gmail-mcp-preset-and-defer-client-oauth.md`

- [ ] **Step 1: Update implementation plan phase text**

In `docs/agent-mode-implementation-plan.md`, replace Phase 13 with:

```md
## Phase 13: Generic Hosted MCP Servers — In Progress

- Remove the broken Gmail preset for Google's first-party Gmail MCP endpoint.
- Remove Shuddhalekhan-owned MCP-client OAuth from v4.
- Keep generic HTTP and stdio MCP server configuration.
- Hosted MCP servers may manage their own downstream OAuth internally.
- If a hosted server is not authorized with its downstream service, Shuddhalekhan surfaces the server's MCP status/tool errors rather than adding app-owned login UI.
- Agent Mode works without any MCP server configured.
```

Also remove earlier bullets that say:

```md
- Gmail preset.
- Gmail preset is single-instance in v4.
```

Replace with:

```md
- generic HTTP and stdio MCP server entries.
- MCP presets/templates are not shipped in v4.
```

- [ ] **Step 2: Update README feature bullets**

In `README.md`, replace stale feature bullets:

```md
- Settings window for audio, Whisper, Agent provider, MCP servers, Gmail preset setup, and per-tool approval policies.
- OAuth callback flow for HTTP MCP integrations such as Gmail.
```

with:

```md
- Settings window for audio, Whisper, Agent provider, generic MCP servers, and per-tool approval policies.
- Generic HTTP and stdio MCP server configuration for Agent Mode.
```

Replace:

```md
- `src/agent/` local agent sidecar, MCP registry, OAuth provider, audit logging, and runtime protocol
```

with:

```md
- `src/agent/` local agent sidecar, MCP registry, audit logging, and runtime protocol
```

Replace roadmap/status lines:

```md
- OAuth-enabled HTTP MCP servers.
- A Gmail preset for Google's Gmail MCP endpoint.
```

with:

```md
- Connection-level MCP-client OAuth is deferred until there is a generic authentication model.
- MCP presets/templates are intentionally not shipped in v4.
```

- [ ] **Step 3: Search docs for stale claims**

Run:

```powershell
rg -n "Gmail preset|gmailmcp|OAuth callback flow|OAuth provider|GOOGLE_CLIENT|transport\\.oauth|client OAuth|client-OAuth" README.md docs CONTEXT.md
```

Expected: matches only in ADR/context passages that intentionally explain removal/deferment.

- [ ] **Step 4: Commit**

```powershell
git add docs/agent-mode-implementation-plan.md README.md CONTEXT.md docs/adr/0002-remove-gmail-mcp-preset-and-defer-client-oauth.md
git commit -m "docs: document generic mcp registry direction"
```

---

### Task 6: Final Verification

**Files:**
- No planned source changes unless verification finds issues.

- [ ] **Step 1: Run lint**

Run:

```powershell
bun run lint
```

Expected: PASS with no unused imports, especially in `McpSettings.tsx`, `mcp-registry.ts`, and `sidecar-event-router.ts`.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
bun run typecheck
```

Expected: PASS. Failures mentioning `preset`, `oauth`, `OAuthOpenUrlEvent`, or `openExternal` indicate stale references.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
bun test
```

Expected: PASS.

- [ ] **Step 4: Run final stale-reference search**

Run:

```powershell
rg -n "preset|transport\\.oauth|oauth:open-url|SidecarOAuthProvider|OAuthOpenUrlEvent|gmailmcp|GOOGLE_CLIENT|gmail\\.readonly|gmail\\.compose" src README.md docs
```

Expected: no matches in `src`; docs matches only in ADR/context text explaining removal/deferment.

- [ ] **Step 5: Inspect git diff**

Run:

```powershell
git diff --stat
git diff -- src/types/ipc.ts src/agent/mcp-server-config.ts src/agent/mcp-registry.ts src/agent/protocol.ts src/main/sidecar-event-router.ts src/renderer/settings/McpSettings.tsx
```

Expected: diff shows removal of preset/client-OAuth behavior only. No build outputs under `out/` or `release/`.

- [ ] **Step 6: Commit verification fixes if any**

If verification required additional fixes:

```powershell
git add <fixed-files>
git commit -m "chore: finish mcp preset oauth cleanup"
```

If no additional fixes were required, do not create an empty commit.

---

## Self-Review

- Spec coverage: The plan removes UI presets, backend preset normalization, persisted OAuth config, client-side OAuth runtime, OAuth protocol event handling, and stale docs. It keeps generic unauthenticated HTTP MCP and stdio MCP behavior.
- Placeholder scan: No unresolved marker text or unspecified implementation steps remain.
- Type consistency: Removed fields are consistently named `preset`, `transport.oauth`, `OAuthOpenUrlEvent`, and `SidecarOAuthProvider`; new examples use generic `mail`/`Hosted Mail` fixtures.
