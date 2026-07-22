# Agent MCP Startup and Empty Response Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make enabled MCP servers automatically connect/register tools when Agent Mode is enabled, and prevent empty successful agent toasts.

**Architecture:** Electron main owns persisted Agent Mode config and starts/stops the sidecar based on the global Agent Mode toggle. The sidecar remains the source of live MCP connections and emits runtime status/tool discovery events. The agent runtime converts empty model completions into explicit degraded responses before emitting terminal completion.

**Tech Stack:** Electron main/preload, React settings UI, Bun tests, Vercel AI SDK, `@ai-sdk/mcp`, TypeScript.

---

## File Structure

- Modify `src/main/index.ts`: hydrate the sidecar from persisted config during app startup when Agent Mode is enabled; keep disabled mode truly inactive.
- Modify `src/renderer/SettingsWindow.tsx`: rename/reframe the manual MCP action from normal discovery to diagnostic reconnect/test.
- Modify `src/agent/runtime.ts`: detect empty final responses in the sidecar runtime, audit the degraded condition, and emit a useful fallback response.
- Modify `src/main/__tests__/index.test.ts`: cover startup sidecar hydration and disabled startup behavior.
- Modify `src/agent/__tests__/runtime.test.ts`: cover empty response fallback behavior with and without tool activity.
- Optional modify `src/renderer/__tests__/...` only if existing renderer tests already cover Settings text. Do not create broad UI tests for this small label change unless needed by current test coverage.

## Current Behavior to Preserve

- `config:set` still starts the sidecar when Agent Mode is enabled and stops it when disabled.
- `mcp:test-server` may temporarily force a selected server enabled for diagnostics.
- `McpRegistry.updateConfig()` remains the place where enabled servers connect and tools are discovered.
- Newly discovered tools still default to `alwaysAsk`.
- Do not run `bun run build` or other build commands.

---

### Task 1: Start Sidecar From Persisted Config on App Ready

**Files:**
- Modify: `src/main/index.ts`
- Test: `src/main/__tests__/index.test.ts`

- [ ] **Step 1: Write failing startup hydration tests**

Add tests near the existing app lifecycle or agent tests in `src/main/__tests__/index.test.ts`. Use the existing mocks in that file.

```ts
it('starts the agent sidecar on app ready when persisted Agent Mode is enabled', async () => {
  const config = {
    ...baseConfig,
    agent: {
      ...baseConfig.agent,
      enabled: true,
      provider: {
        baseUrl: 'http://localhost:11434/v1',
        model: 'local-model',
        apiKeyEnvVar: '',
      },
      mcpServers: [
        {
          id: 'srv1',
          displayName: 'Local MCP',
          enabled: true,
          transport: { type: 'http' as const, url: 'http://localhost:3000/mcp' },
          discoveredTools: [],
          toolPolicies: {},
        },
      ],
    },
  };
  getConfigMock.mockReturnValue(config);

  await import(`../index?test=${Date.now()}-agent-startup-enabled`);
  await runWhenReady();

  expect(agentStart).toHaveBeenCalledWith(config);
});

it('does not start the agent sidecar on app ready when Agent Mode is disabled', async () => {
  const config = {
    ...baseConfig,
    agent: {
      ...baseConfig.agent,
      enabled: false,
      mcpServers: [
        {
          id: 'srv1',
          displayName: 'Local MCP',
          enabled: true,
          transport: { type: 'http' as const, url: 'http://localhost:3000/mcp' },
          discoveredTools: [],
          toolPolicies: {},
        },
      ],
    },
  };
  getConfigMock.mockReturnValue(config);

  await import(`../index?test=${Date.now()}-agent-startup-disabled`);
  await runWhenReady();

  expect(agentStart).not.toHaveBeenCalled();
});
```

If the existing test helper is not named `runWhenReady`, use the existing app-ready helper pattern already present in `src/main/__tests__/index.test.ts`; do not invent a second app mock style.

- [ ] **Step 2: Run the focused failing tests**

Run:

```powershell
bun test src/main/__tests__/index.test.ts
```

Expected: the enabled startup test fails because `agentStart` is not called during `app.whenReady()`.

- [ ] **Step 3: Implement startup hydration**

In `src/main/index.ts`, inside `app.whenReady().then(() => { ... })`, after `createTray(...)` and before updater setup is fine, add a persisted-config check:

```ts
  const startupConfig = getConfig();
  if (startupConfig.agent.enabled) {
    agentSidecar.start(startupConfig);
  }
```

Keep `keyboardHook.start(..., () => getConfig().agent.enabled)` unchanged so the hotkey still reads fresh config.

- [ ] **Step 4: Run the focused tests again**

Run:

```powershell
bun test src/main/__tests__/index.test.ts
```

Expected: PASS.

---

### Task 2: Reframe Manual MCP Action as Diagnostic Reconnect/Test

**Files:**
- Modify: `src/renderer/SettingsWindow.tsx`
- Test: existing renderer tests only if they assert this text

- [ ] **Step 1: Update the button copy**

In `src/renderer/SettingsWindow.tsx`, find the MCP server action button that currently renders:

```tsx
Test and Discover Tools
```

Replace it with:

```tsx
Reconnect / Test
```

If surrounding variable names use `onTest`, leave the prop name alone for this small change. Do not refactor the settings component just for naming.

- [ ] **Step 2: Update any matching text assertions**

Search:

```powershell
rg -n "Test and Discover Tools|Reconnect / Test" src
```

If tests assert the old label, update them to the new label.

- [ ] **Step 3: Run lint for the touched renderer file**

Run the repository lint command:

```powershell
bun run lint
```

Expected: PASS. If unrelated existing lint failures appear, record them and do not broaden this task.

---

### Task 3: Convert Empty Agent Completions Into Degraded Responses

**Files:**
- Modify: `src/agent/runtime.ts`
- Test: `src/agent/__tests__/runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Add two tests to `src/agent/__tests__/runtime.test.ts`, adapting to the existing mock structure in that file.

Test A: empty response with no tools should complete with a clear degraded message and audit the condition.

```ts
it('turns an empty no-tool model completion into a degraded visible response', async () => {
  streamTextMock.mockReturnValue({
    text: Promise.resolve(''),
    steps: Promise.resolve([{ toolCalls: [], toolResults: [] }]),
    toolCalls: Promise.resolve([]),
    toolResults: Promise.resolve([]),
  });

  const callbacks = createCallbacks();
  await runAgent('run-1', 'say hello', localProviderConfig, {}, new AbortController().signal, callbacks);

  expect(callbacks.onAudit).toHaveBeenCalledWith('empty_response_degraded', {
    toolSummary: [],
    hadToolActivity: false,
  });
  expect(callbacks.onCompleted).toHaveBeenCalledWith(
    'The agent completed, but returned an empty response.',
    []
  );
});
```

Test B: empty response with tool activity should include a useful tool-based fallback.

```ts
it('summarizes observable tool activity when the final model response is empty', async () => {
  streamTextMock.mockReturnValue({
    text: Promise.resolve(''),
    steps: Promise.resolve([
      {
        toolCalls: [{ toolName: 'srv1__search' }],
        toolResults: [{ toolName: 'srv1__search', result: 'ok' }],
      },
    ]),
    toolCalls: Promise.resolve([{ toolName: 'srv1__search' }]),
    toolResults: Promise.resolve([{ toolName: 'srv1__search', result: 'ok' }]),
  });

  const callbacks = createCallbacks();
  await runAgent('run-1', 'search web', localProviderConfig, {}, new AbortController().signal, callbacks);

  expect(callbacks.onAudit).toHaveBeenCalledWith('empty_response_degraded', {
    toolSummary: ['Used srv1__search'],
    hadToolActivity: true,
  });
  expect(callbacks.onCompleted).toHaveBeenCalledWith(
    'The agent completed tool work but returned no final text.',
    ['Used srv1__search']
  );
});
```

Use the existing helper names from the file. If the helper names differ, keep the assertions exactly equivalent.

- [ ] **Step 2: Run the focused failing runtime tests**

Run:

```powershell
bun test src/agent/__tests__/runtime.test.ts
```

Expected: new tests fail because empty responses currently complete with `''`.

- [ ] **Step 3: Implement the degraded response helper**

In `src/agent/runtime.ts`, add this helper near the other formatting helpers:

```ts
function normalizeFinalResponse(
  response: string,
  toolSummary: string[],
  callbacks: AgentRuntimeCallbacks
): string {
  if (response.trim()) return response;

  const hadToolActivity = toolSummary.length > 0;
  callbacks.onAudit?.('empty_response_degraded', {
    toolSummary,
    hadToolActivity,
  });

  return hadToolActivity
    ? 'The agent completed tool work but returned no final text.'
    : 'The agent completed, but returned an empty response.';
}
```

Then in `runAgent`, after `toolSummary` is fully built and after the max-step fallback block, but before `callbacks.onAudit?.('run_completed', ...)`, add:

```ts
    finalResponse = normalizeFinalResponse(finalResponse, toolSummary, callbacks);
```

Do not call `onResponseDelta` for this fallback unless an existing test or UX requirement demands streaming the fallback before completion. The final completed toast will render `event.response`.

- [ ] **Step 4: Run the focused runtime tests again**

Run:

```powershell
bun test src/agent/__tests__/runtime.test.ts
```

Expected: PASS.

---

### Task 4: Verify Config Persistence Still Drives MCP Tool Policies

**Files:**
- Modify only if tests reveal a regression: `src/main/config.ts`, `src/agent/mcp-registry.ts`
- Test: `src/main/__tests__/config.test.ts`, `src/agent/__tests__/mcp-registry.test.ts`

- [ ] **Step 1: Run existing config and MCP registry tests**

Run:

```powershell
bun test src/main/__tests__/config.test.ts src/agent/__tests__/mcp-registry.test.ts
```

Expected: PASS. These tests protect the persisted discovered-tool cache, default `alwaysAsk` policy, and live registry snapshot behavior.

- [ ] **Step 2: If tests fail, keep the fix narrow**

Only change code if the startup hydration work exposed an actual regression. The intended behavior is already implemented in `McpRegistry.updateConfig()`:

```ts
const enabledServers = new Map(config.agent.mcpServers.filter((server) => server.enabled).map((server) => [server.id, server]));
```

Do not move MCP connection state into renderer config or persisted `discoveredTools`.

---

### Task 5: Full Verification

**Files:**
- No code changes unless verification exposes a defect.

- [ ] **Step 1: Run all pre-commit checks from `AGENTS.md`**

Run:

```powershell
bun run lint
bun run typecheck
bun test
```

Expected: all pass.

- [ ] **Step 2: Manual smoke path in dev**

Run:

```powershell
bun run dev
```

Expected:

- With Agent Mode enabled and an enabled MCP server saved, app startup logs MCP connection/discovery without pressing the manual button.
- Settings shows live `connected` only after the sidecar reports an active connection.
- Pressing `Reconnect / Test` still reconnects/tests the selected server.
- An agent run with no final model text does not show an empty “Complete” toast.

Do not run any build command.

---

## Self-Review

Spec coverage:
- Startup preference persistence is covered by Task 1.
- Automatic MCP connect/discover is covered by Task 1 plus existing `McpRegistry.updateConfig()` behavior.
- Manual discovery button UX is covered by Task 2.
- Empty completed toast is covered by Task 3.
- Existing policy/cache behavior is protected by Task 4.
- Required repo verification is covered by Task 5.

Placeholder scan:
- No `TBD`, open-ended TODO, or unspecified test steps remain.

Type consistency:
- Uses existing `AppConfig`, `McpServerConfig`, `AgentRuntimeCallbacks`, `agentSidecar.start(config)`, and `runAgent(...)` signatures.
