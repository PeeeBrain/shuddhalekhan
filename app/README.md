# Shuddhalekhan

Speech-to-text dictation app with an optional voice-first Agent Mode.

Audio is recorded locally, sent to a Whisper-compatible HTTP endpoint, and then routed by intent:

- Dictation defaults to `Ctrl+Win`; Agent Mode defaults to `Alt+Win`. Each global shortcut and its Push to Talk or Toggle behavior can be configured independently under Settings → Shortcuts.
- Configured trigger events are consumed while active. Global shortcuts can be paused for the current app session from Settings or the tray.

Agent Mode is opt-in from Settings. When disabled, the agent sidecar and MCP connections stay inactive.

## Features

- Global Windows hotkeys for Dictation and Agent Mode.
- Tray-first operation with microphone selection, transcription cleanup toggle, update checks, Settings, and exit.
- Local Whisper-compatible transcription endpoint support.
- Clipboard-safe text injection for Dictation.
- Settings window for audio, Whisper, Agent provider, generic MCP servers, and per-tool approval policies.
- Agent Mode powered by the Vercel AI SDK and OpenAI-compatible model providers.
- MCP client support for stdio and HTTP MCP servers.
- Generic HTTP and stdio MCP server configuration for Agent Mode.
- Approval toasts for sensitive MCP tool calls, with per-tool policies: disabled, always ask, or always allow.
- Local SQLite audit logging for agent runs, tool requests, approvals, results, and failures.
- Electron auto-update support through GitHub Releases.

## Stack

- Frontend: React + TypeScript + Vite
- Desktop runtime: Electron
- Agent runtime: Vercel AI SDK + MCP
- Local data: electron-store + SQLite audit log
- Native Windows integration: Koffi

## Project Layout

- `src/renderer/` React UI (recording popup + hidden audio window)
- `src/main/` Electron main process logic (hotkey, tray, Whisper, text injection)
- `src/agent/` local agent sidecar, MCP registry, audit logging, and runtime protocol
- `src/preload/` IPC bridge
- `icons/` application and tray icons

## Development

Install JS dependencies:

```bash
bun install
```

Typecheck:

```bash
bun run typecheck
```

Lint:

```bash
bun run lint
```

Run tests:

```bash
bun test
```

Run Electron app in dev mode:

```bash
bun run dev
```

Build production app artifacts locally:

```bash
bun run dist
```

The GitHub release workflow treats a pushed semantic version tag (for example,
`v4.5.2`) as the sole release-version authority. It injects that version into
the Windows app, runs lint, typecheck, tests, build, and Electron Builder
packaging, then publishes artifacts with release notes generated from Git
history.

For contribution guidelines and PR checks, see [CONTRIBUTING.md](CONTRIBUTING.md). The human-approved release runbook is in [docs/releasing.md](docs/releasing.md).

## Whisper Server Setup

The application requires a Whisper-compatible HTTP endpoint to transcribe audio. By default it posts to:

```text
http://localhost:8080/inference
```

The request is sent as `multipart/form-data` with a WAV `file`, `temperature=0.2`, `response_format=json`, and an explicit `translate=true|false` flag. When a spoken language is selected in Settings, the request also includes `language=<code>`. When transcription cleanup is enabled, resultant transcriptions are much cleaner excluding filler words (umms and ahhs) and common transcription artifacts.

### Option 1: Local whisper.cpp with Docker (Recommended)

**Requirements:**
- Docker Desktop with GPU support
- NVIDIA GPU with CUDA

**One-time Setup:**

1. **Create model directory:**
   ```powershell
   New-Item -Path "C:\whisper\models" -ItemType Directory -Force
   ```

2. **Download quantized model (Q5_0, 574 MB):**
   ```powershell
   curl -L -o "C:\whisper\models\ggml-large-v3-turbo-q5_0.bin" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
   ```

3. **Start whisper.cpp Docker container:**
   ```powershell
   docker run -dit --name whisper-cuda-server --entrypoint /app/build/bin/whisper-server `
     -p 8080:8080 --gpus all `
     -v "C:\whisper\models:/app/models" `
     -e "LD_LIBRARY_PATH=/usr/local/cuda-13.0/lib64:/usr/local/cuda-13.0/compat/lib64" `
     -e "GGML_CUDA=1" `
     --restart unless-stopped `
     ghcr.io/ggml-org/whisper.cpp:main-cuda-f53dc74843e97f19f94a79241357f74ad5b691a6 `
     --port 8080 --host 0.0.0.0 -m /app/models/ggml-large-v3-turbo-q5_0.bin
   ```

**⚠️ IMPORTANT:** The `LD_LIBRARY_PATH` environment variable is critical for CUDA GPU detection. Without it, the container falls back to CPU-only mode.

**Start server on reboot:**
```powershell
docker start whisper-cuda-server
```

### Option 2: OpenAI Whisper API

The app's current Whisper client does not include request-header configuration, so hosted APIs that require authentication need code changes before they can be used directly.

### Option 3: Other Whisper Providers

The app works with any compatible unauthenticated endpoint that accepts the same multipart WAV upload shape, such as:
- LocalAI
- Self-hosted whisper.cpp instances

## Agent Mode Setup

Agent Mode turns a spoken command into a one-off local agent run. It does not replace Dictation, does not inject agent responses into the focused app, and does not keep chat history between commands.

Open Settings from the tray menu, then configure:

1. Enable Agent Mode.
2. Set an OpenAI-compatible provider base URL.
3. Set the model name.
4. Set the environment variable name that contains the provider API key.

The API key value is not stored in Shuddhalekhan config. Only the environment variable name is saved.

Examples of provider-style configuration:

```text
Base URL: https://openrouter.ai/api/v1
Model: openai/gpt-5.4-mini
API key env var: OPENROUTER_API_KEY
```

For local providers that do not require an API key, leave the API key environment variable empty if the provider supports that.

### MCP Servers

Agent Mode can run without MCP servers, but MCP servers are what let it use external tools.

Settings supports:

- stdio MCP servers with command, arguments, and inherited environment variable names.
- HTTP MCP servers by URL, including protected remote servers that advertise standard MCP OAuth.
- Per-tool approval policies after tool discovery.

When Agent Mode is enabled, enabled MCP servers reconnect automatically on app startup and tools are discovered for the settings UI. Newly discovered tools default to `alwaysAsk`.

MCP-client OAuth is generic: Shuddhalekhan opens the server-provided authorization URL, stores tokens per MCP server, and sends bearer tokens through the AI SDK transport. MCP presets/templates are intentionally not shipped in v4.

### Tool Approvals

Tool calls with `alwaysAsk` show an approval toast. You can approve, deny, or deny with a short message that is returned to the active agent run. Approval prompts expire after 30 seconds.

Disabled tools are not exposed to the model. Always-allowed tools can run without prompting, so use that policy only for tools you trust.

### Agent Audit Log

Agent Mode writes a local SQLite audit database named `agent-audit.sqlite` under the Shuddhalekhan app data directory. The audit log is for local debugging and records agent run events, tool requests, approval decisions, tool results, errors, and final responses. Shuddhalekhan does not send audit data to a remote service.

## Notes

- The app is **Windows-only** because global keyboard hooks and paste simulation call Windows APIs through `koffi`.
- Dictation defaults to the global `Ctrl+Win` chord and can be reassigned or cleared.
- Agent Mode defaults to `Alt+Win`, can be configured independently, and remains dormant while Agent Mode is disabled.
- The tray menu supports microphone selection, transcription cleanup toggling, Settings, manual update checks, and exit.
- Recording popup is bottom-center and pill-shaped, with a distinct Agent Mode visual state.
- Agent responses and approvals appear as toast windows near the bottom-right of the primary display.
- Active configuration is stored with `electron-store` under the `shuddhalekhan-config` store name.
- Updates are packaged with Electron Builder and checked with `electron-updater`.
