# Project Decisions

## Product Name
- **Canonical**: **Shuddhalekhan** (Marathi: शुद्धलेखन)
- **Rationale**: Replaces the temporary "speech-2-text" identifier across the app, config, releases, and repository.

## Package Manager
- **Primary**: `bun` — chosen for install/build speed.
- **Fallback**: `pnpm` — to be adopted if `bun` causes resolution or native-addon issues (e.g., `koffi`).

## Build Tool
- **Frontend + Main + Preload**: `electron-vite` (Vite-based, preserves existing frontend build pipeline).

## Agent Runtime
- **Library**: Vercel AI SDK with `@ai-sdk/mcp`.
- **Rationale**: TypeScript-first, provider-agnostic, fast to iterate, and small enough that Shuddhalekhan can own MCP registry, per-tool approval policy, sidecar protocol, and audit behavior directly.

## Auto-Updater
- **Mechanism**: `electron-updater` with GitHub Releases.
- **Rationale**: Industry standard, no custom JSON endpoint or minisign key required. Build pipeline generates `latest.yml` automatically.

## Configuration
- **Library**: `electron-store` (typed, atomic, industry standard for Electron).
- **Legacy path**: `~/.speech-2-text/config.json` — to be migrated on first run if present.

## Decision Principle
- Prefer widely-documented, industry-standard libraries and patterns over custom solutions. This ensures future breakage is Google-able.

# Domain Glossary

## Core Concepts

### Recording Pill
The small floating UI window displayed at the bottom-center of the screen while recording is active. Rendered as a rounded pill shape with animated audio level bars. Exists in two visual modes:

- **Transcription Mode** — Blue-hued pill (border glow, shadow) indicating standard speech-to-text recording.
- **Agent Mode** — Red-hued pill indicating the recording will be routed to the AI agent for tool execution. Discontinued during the v3 Electron port and revived in v4 as the visual state for `Alt + Win` agent commands.

### Recording Session
A deep module that owns the complete audio-capture lifecycle: keyboard hook, hidden audio window, recording pill visibility, and transcription. Callers use three verbs — `begin(intent)`, `end()`, `cancel()` — and receive `{ text, intent }` on completion. The session hides the audio-window readiness race (`pendingStartRecording`), modifier-state tracking, and process-crash recovery behind its seam. Dictation/Agent routing (clipboard paste vs. sidecar dispatch) stays in the Electron main orchestrator, not inside the session.

### Dictation
The act of converting captured audio into text and injecting it into the currently focused application. Triggered by holding the `Ctrl + Win` hotkey chord. Synonymous with "transcription mode" in user-facing language.

### Agent (Jarvis)
The local AI assistant that receives transcribed prompts, interprets them, and can execute tools. Triggered by holding the `Alt + Win` hotkey chord, separate from `Ctrl + Win` Dictation.

The agent runtime runs in a separate local sidecar process managed by Electron. Electron owns hotkeys, recording state, windows, configuration, and user approval surfaces; the sidecar owns the agent SDK, model client, MCP client sessions, and tool execution loop. Cross-process communication must use explicit request IDs and cancellation/timeout handling so stale agent responses cannot affect the current recording session.

Agent Mode is single-flight in v4: only one active agent run may exist at a time. Holding `Alt + Win` while an agent run is active cancels the previous run gracefully, closes any pending approval UI, and starts a new recording/run. Cancellation must release model and MCP resources cleanly so local providers such as Ollama remain reachable for the next run.

Cancellation is state-aware. Before tool execution, cancellation stops the run without external side effects. During tool execution, cancellation aborts model streaming and requests MCP/tool abortion where supported; if a tool call cannot be aborted, the sidecar waits for it to settle but does not feed the result back into the cancelled loop. After tool execution, any completed side effect is still recorded in the audit trail, but stale results cannot update the current run or UI.

The sidecar process may stay running while Shuddhalekhan is open, but Agent Mode UI is event-driven and hidden when idle. Red recording pills and tasteful toast-style notifications appear only while recording, waiting for approval, reporting tool activity, or showing a response.

Agent Mode is stateless by default. Each `Alt + Win` command is a one-off fire-and-forget request: transcribe, run the agent/tool loop, present a final visual response, then end. Shuddhalekhan does not provide a chat surface and does not carry conversational history between agent commands by default.

Agent Mode shows minimal live tool-status toasts while a run is active, such as checking Gmail, reading messages, drafting a reply, or waiting for approval. The final response toast includes the agent's final answer and a compact tool summary. Raw tool arguments, detailed results, and audit details are not shown in transient toasts unless needed for approval.

### Toast Visual Direction
- All toasts use a **minimal, native-feeling card** aesthetic: `bg-card`, `border-border`, subtle shadow, no CSS grid patterns, no gradient backgrounds
- State is communicated via a **small left accent border** (color-coded: blue for agent thinking, amber for approval, red for failure, green for success)
- Typography uses standard theme sizes; content is the star, not the container
- **Approval toasts are slightly heightened**: warm amber left border and a subtle shadow lift to signal urgency, but nothing radical or theatrical

An empty model response is not a successful user-facing final answer. If an agent run reaches completion with no final text, Shuddhalekhan treats it as a degraded completion: it shows a useful fallback based on observable tool activity when possible, otherwise shows a clear empty-response failure/degraded message, and records the condition in the audit trail.

Agent Mode writes full local audit logs for agent runs, including transcripts, prompts, tool requests, tool arguments, approval decisions, tool results, errors, and final responses. The audit store is a small local SQLite database owned only by the agent sidecar so runs, tool calls, approvals, and results can be queried by ID during debugging. Electron main does not write to or depend on this database, and v4 does not expose it as a user-facing history feature. Runtime/process logs may still use the appropriate Shuddhalekhan application log directory on disk. Audit data is not sent to remote services by Shuddhalekhan.

Electron owns MCP registry persistence and settings UI. The sidecar receives sanitized runtime config snapshots, connects to enabled MCP servers, discovers tools, and reports status/tool metadata back to Electron. MCP registry changes are hot-reloaded while the app is running: new servers connect, disabled servers disconnect, changed server connections restart, and tool policy changes apply without reconnecting. Active agent runs use the immutable MCP/tool-policy snapshot they started with; config changes apply to future runs.

Shuddhalekhan prefers MCP servers that manage their own service-specific authentication when possible. For stdio MCP servers, configuration may reference environment variables inherited by the sidecar or loaded from a local env-style source. MCP server secrets are env-var-only in v4; Shuddhalekhan config can name secret environment variables but does not store secret values in `electron-store`.

An OAuth-backed MCP integration can be implemented by the MCP server itself. In that case, the server owns service-specific OAuth details such as provider scopes, callback handling, token refresh, and token storage, while Shuddhalekhan connects to the MCP endpoint as a normal HTTP MCP client. This is the immediate v4 target for hosted Gmail-capable MCP servers: remove the broken built-in Gmail preset and let users configure the hosted server URL through the generic MCP registry.

If a server-managed OAuth integration is not yet authorized, Shuddhalekhan treats it as ordinary MCP server status or tool behavior. Connection/discovery failures surface the server's error message in the MCP server status. Login helpers, authorization URLs, or account-linking steps should be exposed by the MCP server itself as MCP tools or server-specific responses, then governed by the normal tool approval and audit flow. Shuddhalekhan does not add Gmail-specific or generic OAuth login buttons for server-managed OAuth in v4.

An OAuth-enabled HTTP MCP server is a future/advanced case where the MCP connection itself requires an OAuth authorization flow from Shuddhalekhan. Shuddhalekhan v4 does not support this MCP-client OAuth mode after removing the broken Gmail preset workflow. If added later, it must be generic rather than Gmail-specific: the sidecar would own MCP-client OAuth handshakes, browser authorization handoff, token refresh, and token storage; Electron would own only settings UI, persisted non-secret OAuth metadata, and opening the external browser when the sidecar emits an authorization URL.

Shuddhalekhan v4 does not persist MCP-client OAuth configuration on HTTP transports. The previous `transport.oauth` shape is removed because it encoded Gmail/client-credential assumptions that no longer match the product direction. If connection-level OAuth for HTTP MCP is added later, it should be introduced as a fresh generic authentication model.

**Discontinuation history:** Agent Mode was present in the Tauri-era codebase but dropped during the Tauri→Electron port (v3) to limit porting scope. The previous toolset (volume control, web search via browser binary invocation, etc.) proved gimmicky rather than useful for daily workflows.

**Revival hypothesis (v4):** Instead of bespoke system tools, the agent acts as an MCP (Model Context Protocol) client connecting to user-configured MCP servers (e.g., `gmail-mcp`, `stock-analysis-mcp`). The agent becomes a voice interface to existing MCP infrastructure.

### MCP Server Registry
The user-managed list of MCP servers available to Agent Mode. Users configure the registry through Shuddhalekhan UI rather than editing JSON by hand. Each server entry describes how to launch or connect to the MCP server, whether it is enabled, and what approval policy applies to its tools.

The v4 MCP registry UI is generic-only: users add HTTP or stdio servers directly. It does not provide presets, templates, or blessed example configurations. Documentation may mention examples outside the persisted registry flow, but the app UI should not create or imply first-party integration shortcuts.

An MCP server marked "Enabled for Agent Mode" is part of the active Agent Mode tool environment, not merely saved for future use. When Agent Mode is enabled, Shuddhalekhan should keep enabled MCP servers connected, discover/register their tools, and make their runtime status visible without requiring the user to press a separate test or discovery button on every app start.

MCP tool discovery is an automatic lifecycle step of connecting an enabled server. Manual UI actions may test or reconnect a server for diagnostics, but they are not the normal path for making tools available to Agent Mode. Persisted discovered-tool metadata is a settings cache for display and policy editing; the live runtime toolset comes from the sidecar's current connected MCP client snapshot.

MCP server status labels describe live runtime state only. "Connected" is reserved for an active MCP client session in the sidecar. Cached discovered-tool metadata may still be displayed for policy editing when a server is inactive or disconnected, but cached tools do not imply that tools are currently registered for Agent Mode.

Shuddhalekhan does not ship MCP presets in v4, including the previous Gmail preset. The removed Gmail preset targeted Google's first-party Gmail MCP endpoint, which currently requires developer-program access that Shuddhalekhan should not force users to sign up for. Users who want Gmail can add any compatible Gmail-capable MCP server, including a custom hosted server with its own OAuth behavior, through the generic MCP server registry.

### Tool Approval Policy
The per-tool safety policy that decides whether the agent can execute a tool automatically, must ask the user first, or cannot execute the tool at all. Each configured MCP server exposes its discovered tools in the UI, where users can choose a durable policy per tool.

Read-only tools may be allowed by default; sensitive or destructive tools such as sending email, modifying drafts, deleting email, deleting files, or changing external state require a human approval step with approve/deny and an optional user message. Denying with a message should return feedback to the active agent turn so the agent can revise its plan instead of simply failing.

A **Tool Approval Response** is the model-visible AI SDK approval response sent after Shuddhalekhan asks the user whether an approval-gated tool call may execute. Approved responses allow the AI SDK to execute the tool on the resumed model call. Denied responses carry the user's optional reason/corrective feedback back into the active agent turn without executing the tool.

A **Tool Rejection** is the user-facing and audit concept for a requested tool execution that Shuddhalekhan did not allow to run, such as user denial, approval timeout, policy refusal, cancellation, or stale-run cleanup. In AI SDK-native approval flows, user denial and approval timeout are represented to the model as Tool Approval Responses, not as fake Tool Results. Tool Rejections are distinct from **Tool Errors**, where the tool was attempted but failed, and from **Tool Results**, where the tool was attempted and returned output. Cancellation and stale-run cleanup must not continue the model loop.

When a denied Tool Approval Response includes corrective feedback that changes the target, arguments, or scope, the agent should revise and continue. When the denial refuses the action or expresses no consent, the agent should stop and explain briefly. The agent must not retry the exact same rejected tool call.

In v4, every newly discovered MCP tool starts in `alwaysAsk` mode, including Gmail tools. Users must explicitly opt tools into automatic approval through settings; no MCP server receives auto-allow defaults on first configuration. Approval prompts support only approve or deny with an optional feedback message; users cannot edit tool arguments before execution in v4. Approval prompts expire after 30 seconds. Expired approvals deny the AI SDK Tool Approval Response with the reason "Tool approval window expired."

Disabled tools are not exposed to the model. Tools in `alwaysAsk` or `alwaysAllow` mode are exposed through Shuddhalekhan's policy wrapper so policy and audit behavior remains enforced outside the model prompt. In v4, `alwaysAsk` maps to the AI SDK's static tool approval mechanism (`needsApproval: true`); Shuddhalekhan does not use input-sensitive dynamic approval functions. If an MCP tool definition already includes approval metadata, Shuddhalekhan's configured per-tool policy is authoritative.

Tool policies are keyed by MCP server ID plus original MCP tool name, not by tool name alone. Model-facing wrapped tool names may be namespaced to avoid collisions, but audit records preserve the server ID, original tool name, and model-facing name.

MCP server IDs are generated and stable. Users can edit server display names, but policies and audit records reference the stable internal server ID so renaming a server does not break policy or history. The Gmail preset is single-instance in v4 to avoid multi-account ambiguity and agent/tool confusion.

The agent system prompt must instruct the agent that if a Tool Approval Response is denied with the reason "Tool approval window expired.", the likely cause is that the user is no longer deliberately focused on the request. The agent should stop execution and respond that it has stopped because tool approval expired, rather than continuing to plan or repeatedly requesting tools.

Tool approvals are sequential in v4. At most one approval prompt may be pending for the active agent run. Auto-approved tools may run without prompting, including in parallel when the AI SDK/model emits parallel tool calls. Approval-gated tools never execute until approved. If one AI SDK assistant message contains both auto-approved and approval-gated tool calls, the auto-approved tools may complete and be recorded while approval-gated calls are queued for human approval. If the AI SDK surfaces multiple approval requests from one assistant message, Shuddhalekhan still presents them to the user sequentially, then sends the collected approval responses back to the AI SDK together before resuming the model call.

Approval prompts focus on the gated tool request itself: server/tool name, model-facing tool name, arguments, approve/deny actions, and optional denial feedback. After the user approves or denies, the approval toast transitions to a non-interactive continuing state until sidecar status, response, completion, or failure events replace it. Approval prompts do not summarize sibling auto-approved tool results in v4; detailed tool context remains in the local audit trail and model-visible message history.

Agent Mode uses an agent/tool loop, but v4 does not show, require, or depend on hidden chain-of-thought traces by default. User-facing UI shows observable progress, approval requests, final response, and compact summaries. Agent Mode settings may include an advanced opt-in toggle named "Show reasoning stream". This toggle is separate from provider Thinking mode: Thinking controls whether compatible providers are asked to spend extra reasoning effort, while Show reasoning stream controls whether Shuddhalekhan displays provider-supplied reasoning text. When enabled, Shuddhalekhan may display provider-supplied AI SDK reasoning stream text transiently in the existing Agent Mode final-response toast, using a familiar collapsible "Thinking…" / "Thought for Xs" presentation aligned with contemporary AI chat applications. Reasoning emitted during intermediate tool-planning turns is not shown; only reasoning associated with the final AI response is eligible for display. Availability and fidelity of reasoning stream text depend on the provider. Raw reasoning stream text is not persisted to audit logs by default. The audit database logs model-visible messages, tool requests, tool arguments, approval decisions, tool results, errors, and final responses.

An **Interrupted Agent Run** is an agent run that ended before normal completion because a newer run replaced it, Agent Mode was disabled, the sidecar shut down, the sidecar/app crashed, or a protocol-level stop request ended the run. Interrupted runs must be represented as terminal audit history statuses rather than remaining indefinitely in a `running`/`thinking` state. Because v4 has no explicit user-facing Cancel action, replaced, stopped, shutdown, and orphaned active runs are all classified as `interrupted` rather than introducing cancellation subtypes. Every `Alt + Win` Agent invocation starts a fresh run with a new UUID, so older interrupted runs are never resumable.

Agent runs are bounded primarily by a maximum agent step count, using Vercel AI SDK's `stopWhen: isStepCount(5)` mechanism rather than relying on wall-clock interruption as the normal stop condition. Wall-clock timeouts are reserved for stuck I/O, cancellation cleanup, or process health protection because abrupt interruption can leave model streams or tool calls in awkward states.

The max step count is an internal v4 guardrail, not a user-facing setting.

When the max step count is reached, the agent must stop using tools and produce a concise final response describing what completed and what remains. If necessary, the sidecar performs a final no-tools model call to generate this status from observable messages and tool results. The audit database records that the run reached the max-step guardrail.

The agent prompt is generic and extensible. A base prompt defines Agent Mode as a stateless one-off command executor that respects tool policies, approval denials, timeout messages, and observable tool results. Shuddhalekhan does not add Gmail-specific agent instructions; MCP tool descriptions and the user's command provide integration context.

Agent Mode is voice-first. A typed "run test command" entry may exist under a development/debug feature flag for diagnostics, MCP testing, OAuth testing, approval lifecycle testing, cancellation testing, and audit validation. It creates the same stateless one-off agent run as a voice command and does not introduce a chat surface.

Agent Mode is opt-in in v4. Users must enable it in settings before the `Alt + Win` global hotkey is active or agent tooling is available. Users who only use Dictation should not encounter Agent Mode UI or sidecar behavior.

When Agent Mode is disabled, Shuddhalekhan does not keep the agent sidecar or MCP server connections alive. MCP Settings may still show saved server configuration and cached discovered-tool metadata, but those servers are inactive until Agent Mode is enabled. Manual diagnostic testing may temporarily connect a server without changing the active runtime environment.

Agent Mode can be enabled even before provider or MCP setup is complete. Each Agent Mode run validates required configuration before starting the sidecar loop. If required fields such as model base URL, model name, or API key environment variable are missing or invalid, Shuddhalekhan shows a clear toast with a Settings entry point instead of silently failing.

Agent Mode does not require Gmail or any MCP server to be configured. Model provider configuration is required to run the agent; MCP tools are optional. When no MCP tools are enabled, the agent runs with an empty toolset and responds accordingly.

The agent sidecar starts lazily only when Agent Mode is enabled and needed, such as opening Agent settings, testing MCP configuration, or starting an Agent Mode run. Disabling Agent Mode cancels any active run, disconnects MCP servers, stops the sidecar, and deactivates `Alt + Win` behavior.

The first MCP lifecycle repair should prioritize the user-visible contract over a broad lifecycle rewrite: hydrate persisted Agent Mode configuration on app startup, connect/discover enabled MCP servers automatically, keep the manual server action diagnostic, and guard against empty final responses. A fuller sidecar lifecycle state machine can follow only if these narrower fixes expose unresolved cancellation, crash recovery, or reconnect semantics.

Hotkeys are hardcoded in v4: `Ctrl + Win` for Dictation and `Alt + Win` for Agent Mode. Implementation should still model them as named recording intents so both hotkeys can become user-configurable in a future version without rewriting the recording state machine.

Agent Mode reuses the existing Whisper transcription path and configuration. Dictation and Agent Mode share audio capture and transcription; after transcription, Dictation injects text into the focused application while Agent Mode sends the transcript to the sidecar as a one-off agent command.

Agent Mode v4 uses an OpenAI-compatible chat/model provider configuration for the sidecar, with OpenRouter as an expected provider. Settings collect base URL, model name, and an API key environment variable name; v4 does not store model API keys directly. Settings should provide a straightforward connection/configuration experience and should not include a separate "test agent tool call" button.

Agent Mode configuration requires a real settings window rather than tray-only UI. The settings design should remain modern, restrained, and consistent with Shuddhalekhan's existing UI; it should avoid card-heavy dashboard patterns and use focused settings sections for audio, agent provider configuration, MCP server registry, Gmail preset/OAuth status, and per-tool approval policies.

The app remains tray-first. The settings window opens only when the user chooses Settings from the tray menu, and it is not shown on app startup. Closing settings returns Shuddhalekhan to background/tray operation.

## UI Architecture Decisions

### Hidden Main Window Removal
The `MainWindow` component and its `BrowserWindow` are removed. The app no longer creates a hidden background renderer. The tray menu and settings window are the only user-facing persistent surfaces.

### Settings Window Design Direction
Settings uses a **floating panel / sheet** style (Apple System Settings / Windows 11 Settings influence):
- Sidebar and content share the same background color (`bg-background`)
- A single subtle 1px separator divides the two panes
- No hardcoded dark panes (`#101214`, `#181b1e` are eliminated in favor of theme tokens)
- Navigation items are minimal text-only rows with hover/active states
- Content area uses generous whitespace rather than dense grid rows
- Layout convention: section headers with loose spacing for simple toggles/reads; stacked label-above-input for text fields (more legible and scales better at narrow widths)

The tray menu shows Agent Mode status and a Settings entry point, but the authoritative Agent Mode enable/disable toggle and all MCP/provider configuration live in Settings.

The agent sidecar is implemented inside this repository under `src/agent/` because it is part of the same application. Electron main manages the sidecar process lifecycle from `src/main/`, while agent runtime, MCP, OAuth, audit, and sidecar protocol code live behind the `src/agent/` source boundary.

Electron main and the agent sidecar communicate over a stdio JSONL protocol in v4. Electron sends config snapshots, agent start requests, cancellation requests, and approval decisions. The sidecar emits readiness, MCP status, live agent status, approval requests, final responses, failures, and cancellation/completion events. Every run-scoped message includes `agentRunId` so stale events can be ignored.

Sidecar stdout is reserved for JSONL protocol messages only. Human-readable process logs go to stderr or the application log directory, and agent audit events go to the sidecar-owned SQLite database. Electron treats malformed stdout lines as protocol errors.

Agent Mode also needs post-tool-use observation so Shuddhalekhan can display what happened, persist an audit trail, and let the active turn continue with the tool result. Post-tool-use hooks are not a substitute for approval because they run after external side effects may already have occurred.

### Text Injection
The process of simulating keystrokes to type transcribed text into the active window. Implemented via the **clipboard sandwich** pattern: save existing clipboard → write text → simulate paste (Ctrl+V) → restore original clipboard. Must not append Enter/newline by default.

## Technical Terms

### Audio Stream
A permanently initialized `cpal` input stream that buffers audio samples in memory. Recording toggles a `discard_audio` flag rather than starting/stopping the stream itself, enabling zero-latency capture.

### Whisper Client
HTTP client that sends recorded WAV audio to a configurable Whisper API endpoint (e.g., a local `whisper.cpp` server) and returns transcribed text.

### Approval Window
Toast-style approval notification displayed when the Agent requests to execute a sensitive tool. Requires explicit user confirmation before proceeding, and may include an optional denial message that is returned to the agent loop as feedback.

### Agent Response Window
Temporary toast-style notification that displays the Agent's final response after its reasoning and tool loop completes. Agent responses are visual-only in v4, are not read aloud by default, and are not injected into the focused application by default.
