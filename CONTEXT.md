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

Shuddhalekhan prefers MCP servers that manage their own OAuth or service authentication when possible. For stdio MCP servers, configuration may reference environment variables inherited by the sidecar or loaded from a local env-style source. MCP server secrets are env-var-only in v4; Shuddhalekhan config can name secret environment variables but does not store secret values in `electron-store`. The v4 Gmail success path targets Google's first-party Gmail remote MCP server at `https://gmailmcp.googleapis.com/mcp/v1`, which uses HTTP transport and OAuth 2.0 with Gmail read and compose scopes. Because this first-party Gmail integration requires OAuth-capable HTTP MCP, Shuddhalekhan v4 must support HTTP MCP OAuth in the sidecar from the start.

Gmail OAuth credentials support two sources: `userProvided` for development/private builds and `bundledAppClient` for future distributed builds. `userProvided` asks the user to supply a Google OAuth client ID/secret from their own Google Cloud project. `bundledAppClient` uses a Shuddhalekhan-owned Google OAuth client after the app is ready for the verification, policy, privacy, and support obligations that come with distribution. Both sources use the same sidecar OAuth flow, token storage, Gmail MCP endpoint, and approval policy.

**Discontinuation history:** Agent Mode was present in the Tauri-era codebase but dropped during the Tauri→Electron port (v3) to limit porting scope. The previous toolset (volume control, web search via browser binary invocation, etc.) proved gimmicky rather than useful for daily workflows.

**Revival hypothesis (v4):** Instead of bespoke system tools, the agent acts as an MCP (Model Context Protocol) client connecting to user-configured MCP servers (e.g., `gmail-mcp`, `stock-analysis-mcp`). The agent becomes a voice interface to existing MCP infrastructure.

### MCP Server Registry
The user-managed list of MCP servers available to Agent Mode. Users configure the registry through Shuddhalekhan UI rather than editing JSON by hand. Each server entry describes how to launch or connect to the MCP server, whether it is enabled, and what approval policy applies to its tools.

An MCP server marked "Enabled for Agent Mode" is part of the active Agent Mode tool environment, not merely saved for future use. When Agent Mode is enabled, Shuddhalekhan should keep enabled MCP servers connected, discover/register their tools, and make their runtime status visible without requiring the user to press a separate test or discovery button on every app start.

MCP tool discovery is an automatic lifecycle step of connecting an enabled server. Manual UI actions may test or reconnect a server for diagnostics, but they are not the normal path for making tools available to Agent Mode. Persisted discovered-tool metadata is a settings cache for display and policy editing; the live runtime toolset comes from the sidecar's current connected MCP client snapshot.

MCP server status labels describe live runtime state only. "Connected" is reserved for an active MCP client session in the sidecar. Cached discovered-tool metadata may still be displayed for policy editing when a server is inactive or disconnected, but cached tools do not imply that tools are currently registered for Agent Mode.

Gmail is the first bundled preset in the registry UX, but it is not hard-coded as the only supported integration. The preset provides a friendly starting point without shipping user credentials.

### Tool Approval Policy
The per-tool safety policy that decides whether the agent can execute a tool automatically, must ask the user first, or cannot execute the tool at all. Each configured MCP server exposes its discovered tools in the UI, where users can choose a durable policy per tool.

Read-only tools may be allowed by default; sensitive or destructive tools such as sending email, modifying drafts, deleting email, deleting files, or changing external state require a human approval step with approve/deny and an optional user message. Denying with a message should return feedback to the active agent turn so the agent can revise its plan instead of simply failing.

In v4, every newly discovered MCP tool starts in `alwaysAsk` mode, including Gmail tools. Users must explicitly opt tools into automatic approval through settings; no MCP server receives auto-allow defaults on first configuration. Approval prompts support only approve or deny with an optional feedback message; users cannot edit tool arguments before execution in v4. Approval prompts expire after 30 seconds. Expired approvals reject the tool call with the hardcoded message: "Rejected: tool approval window expired."

Disabled tools are not exposed to the model. Tools in `alwaysAsk` or `alwaysAllow` mode are exposed through Shuddhalekhan's policy wrapper so approval and audit behavior remains enforced outside the model prompt.

Tool policies are keyed by MCP server ID plus original MCP tool name, not by tool name alone. Model-facing wrapped tool names may be namespaced to avoid collisions, but audit records preserve the server ID, original tool name, and model-facing name.

MCP server IDs are generated and stable. Users can edit server display names, but policies and audit records reference the stable internal server ID so renaming a server does not break policy or history. The Gmail preset is single-instance in v4 to avoid multi-account ambiguity and agent/tool confusion.

The agent system prompt must instruct the agent that if a tool call is rejected with "Rejected: tool approval window expired.", the likely cause is that the user is no longer deliberately focused on the request. The agent should stop execution and respond that it has stopped and is waiting for the user's deliberate focus, rather than continuing to plan or repeatedly requesting tools.

Tool approvals are sequential in v4. At most one approval prompt may be pending for the active agent run. Auto-approved tools may run without prompting, but any tool requiring approval pauses the run until the user approves, denies, the prompt expires, or the run is cancelled.

Agent Mode uses an agent/tool loop, but v4 does not show, require, or depend on hidden chain-of-thought traces. User-facing UI shows observable progress, approval requests, final response, and compact summaries. The audit database logs model-visible messages, tool requests, tool arguments, approval decisions, tool results, errors, and final responses.

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
