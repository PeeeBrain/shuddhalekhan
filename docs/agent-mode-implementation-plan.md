# Agent Mode Implementation Plan

## Goal

Revive Agent Mode as an opt-in, voice-first, stateless command executor. `Ctrl + Win` remains Dictation. `Alt + Win` records a one-off Agent Mode command, transcribes it through the existing Whisper path, sends the transcript to a sidecar agent runtime, and shows minimal live status plus a final visual toast.

## Phase 1: Recording Intent and Hotkeys — Done

- Introduce a `RecordingIntent` type: `dictation | agent`.
- Refactor recording state so start/stop/transcription keeps the active intent.
- Extend the keyboard hook to support:
  - `Ctrl + Win` -> Dictation
  - `Alt + Win` -> Agent Mode, only when Agent Mode is enabled.
- Reuse the existing audio capture and Whisper transcription path.
- Route post-transcription output by intent:
  - Dictation -> clipboard sandwich.
  - Agent -> provider/config validation and sidecar run start.

## Phase 2: Recording Pill Modes — Done

- Extend the recording pill to accept a mode.
- Keep blue styling for Dictation.
- Add red styling for Agent Mode.
- Ensure pill behavior remains transient and hidden when idle.

## Phase 3: Settings Window — Done

- Add a real settings window opened only from the tray.
- Keep the app tray-first; do not show settings on startup.
- Settings sections:
  - General
  - Audio
  - Agent
  - MCP Servers
  - About/Updates
- Use a restrained operational UI consistent with the current app. Avoid card-heavy dashboard layout.
- Agent settings:
  - Enable Agent Mode.
  - OpenAI-compatible base URL.
  - model name.
  - API key environment variable name.
  - dev/debug typed command entry behind feature flag.
- MCP settings:
  - registry list.
  - Gmail preset.
  - server status.
  - discovered tools and per-tool policy.

## Phase 4: Config Schema — Done

- Extend `AppConfig` with:
  - `agent.enabled`
  - `agent.provider.baseUrl`
  - `agent.provider.model`
  - `agent.provider.apiKeyEnvVar`
  - `agent.mcpServers[]`
- MCP server entries include stable generated ID, display name, transport config, enabled flag, discovered tools, and tool policies.
- Every newly discovered tool defaults to `alwaysAsk`.
- Tool policies are keyed by server ID plus original MCP tool name.
- Disabled tools are not exposed to the model.
- Gmail preset is single-instance in v4.

## Phase 5: Sidecar Build Boundary — Done

- Add sidecar source under `src/agent/`.
- Keep Electron lifecycle management in `src/main/`.
- Add a build target for the sidecar output.
- Use Bun-compatible TypeScript.
- Reserve sidecar stdout for JSONL protocol only.
- Send process logs to stderr/application logs.

## Phase 6: JSONL Sidecar Protocol — Done

- Implement Electron -> sidecar messages:
  - `config:update`
  - `agent:start`
  - `agent:cancel`
  - `approval:decision`
- Implement sidecar -> Electron events:
  - `sidecar:ready`
  - `mcp:server-status`
  - `agent:status`
  - `approval:requested`
  - `agent:completed`
  - `agent:failed`
  - `agent:cancelled`
- Every run-scoped message includes `agentRunId`.
- Electron ignores stale events that do not match the current active run.

## Phase 7: Sidecar Lifecycle and Single-Flight Runs — Done

- Start sidecar lazily when Agent Mode is enabled and needed.
- Stop sidecar when Agent Mode is disabled.
- Support exactly one active agent run.
- Starting a new Agent Mode recording while a run is active gracefully cancels the previous run.
- Cancellation behavior:
  - before tool execution: stop cleanly.
  - during tool execution: abort where supported; otherwise wait for settlement but do not continue the cancelled loop.
  - after tool execution: audit side effects but do not update the current run.

## Phase 8: Vercel AI SDK Runtime — Done

- Use Vercel AI SDK with OpenAI-compatible provider configuration.
- Use `@ai-sdk/mcp` for MCP tools.
- Use a generic base agent prompt only.
- No Gmail-specific agent instructions.
- Agent runs are stateless one-off requests.
- Use `stopWhen: isStepCount(5)`.
- If max steps are reached, produce a final no-tools status response.
- MCP tools are optional; provider config is required.

## Phase 9: Tool Policy Wrapper and Approval Flow — Done

- Wrap every exposed MCP tool.
- Policy behavior:
  - `disabled`: hide from model.
  - `alwaysAsk`: pause and request approval.
  - `alwaysAllow`: execute directly.
- Approval prompts are sequential; at most one pending approval per run.
- Approval UI supports only approve or deny with optional message.
- No argument editing in v4.
- Approval expires after 30 seconds.
- Expired approval returns: `Rejected: tool approval window expired.`
- Agent prompt instructs the agent to stop when it receives that timeout rejection.

## Phase 10: Toast UI — Done

- Add transient toast surfaces for:
  - config missing/invalid.
  - live agent status.
  - approval prompt.
  - final agent response.
  - cancellation/failure.
- Final responses are visual-only.
- Agent responses are not injected into the focused app by default.
- Live status should be minimal, such as checking tools, reading, drafting, waiting for approval.

## Phase 11: SQLite Audit Store — Done

- Sidecar owns `agent-audit.sqlite`.
- Electron main does not write to or depend on the DB.
- Log full observable agent events:
  - transcript.
  - model-visible messages.
  - tool requests.
  - tool arguments.
  - approval decisions.
  - tool results.
  - errors.
  - final response.
  - cancellation and max-step events.
- Do not log secrets, auth codes, access tokens, refresh tokens, API keys, or Authorization headers.

## Phase 12: MCP Registry and Hot Reload — Done

- Electron owns MCP registry persistence and settings UI.
- Sidecar receives sanitized runtime snapshots.
- Config updates are hot-reloaded:
  - new enabled server connects.
  - disabled server disconnects.
  - changed server connection restarts.
  - tool policy changes apply without reconnecting.
- Active runs use the immutable MCP/tool-policy snapshot they started with.

## Phase 13: Official Gmail MCP

- Add Gmail preset for Google's first-party Gmail MCP endpoint:
  - `https://gmailmcp.googleapis.com/mcp/v1`
- Use HTTP MCP OAuth from the sidecar.
- Support credential source modes:
  - `userProvided` for development/private builds.
  - `bundledAppClient` for future distribution.
- v4 can start with `userProvided`.
- OAuth flow:
  - settings collects required credential metadata.
  - user clicks connect.
  - browser-based Google OAuth flow completes.
  - sidecar stores tokens securely outside `electron-store` and audit DB.
- Gmail MCP is optional. Agent Mode works without it.

## Phase 14: Verification

- Add unit tests for:
  - recording intent routing.
  - keyboard hook mode detection.
  - config schema defaults.
  - sidecar JSONL parser.
  - stale `agentRunId` rejection.
  - tool policy wrapper.
  - approval timeout behavior.
  - max-step fallback behavior.
- Run:
  - `bun run lint`
  - `bun run typecheck`
  - `bun test`
