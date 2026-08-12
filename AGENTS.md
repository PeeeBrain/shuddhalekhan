# Shuddhalekhan

Shuddhalekhan is a minimal desktop application used for dictation and prompting native agents via voice.

You can think of Shuddhalekhan as an open source "bring-your-own-subscription" alternative to apps WhisrFlow. Users can bring in their API keys for Speech-to-text models and even for LLMs. Shuddhalekhan provides a lightweight harness with native MCP integration so you can modify the harness' behaviour using MCP tools to let agents access to tools and data. Users inteface with agents when prompting them with a configured hotkey. The spoken text gets transcribed and passed to the agent harness and users can see the agents live action in global toast notifications and tool approval pop-ups.


### 1. Open at the core

Shuddhalekhan is truly open. It doesnt lock down users with model providers; both for dictation and agents. Even though the current userbase is negligible (as of 12-08-206, just 1 start and 1 fork to the repo), users are encouraged to fork the application and configure it to their liking.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance Shuddhalekhan. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.



## A note from Partha

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.


## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing Shuddhalekhan.
- **we, us, and maintainers** mean Partha and anyone maintaining Shuddhalekhan. These are who you are talking to now.
- **user** means the person running the Shuddhalekhan desktop app for dictation and/or Agent Mode.
- **Dictation** means speech-to-text into the focused app. Synonymous with "transcription mode" in user-facing language.
- **Agent Mode** means the opt-in voice-to-agent path. Spoken text is transcribed, then sent as a one-off command to the local agent. It is not a chat surface and does not keep conversational history by default.
- **agent** / **agent run** means one single-flight Agent Mode execution inside the app (model + tools). Depending on context, "agent" may also mean you.
- **sidecar** means the local agent process under `app/src/agent/`. Electron main owns hotkeys, windows, config, and approvals; the sidecar owns the AI SDK runtime, MCP clients, tool loop, and audit log.
- **provider** means the OpenAI-compatible model endpoint Agent Mode calls (base URL + model + API key env-var name). Keys are never stored in config.
- **Whisper** / **transcription endpoint** means the Whisper-compatible HTTP service that turns recorded audio into text. Shared by Dictation and Agent Mode.
- **recording pill** means the floating bottom-center UI shown while recording (blue for Dictation, red for Agent Mode).
- **toast** means a transient notification (agent status, tool approval, final response, or failure), usually near the bottom-right.
- **MCP registry** means the user-configured list of HTTP/stdio MCP servers in Settings. No presets in v4; tools are discovered from connected servers.
- **tool approval policy** means the per-tool setting: `disabled`, `alwaysAsk`, or `alwaysAllow`. Newly discovered tools default to `alwaysAsk`.
- **text injection** means pasting transcribed Dictation text into the focused window via the clipboard-sandwich pattern.
- **app data** means Electron's application data directory: `electron-store` config (`shuddhalekhan-config`) and the sidecar-owned `agent-audit.sqlite`.



## Dev servers

- `bun install` from the repo root. Workspaces are `app/` (Electron desktop) and `web/` (landing page). If native modules look broken after install, run `bun x electron-builder install-app-deps` from `app/`.
- `bun run dev` (or `bun run dev:app`) starts the Electron app via `electron-vite`. Prefer this for almost all product work.
- `bun run dev:web` starts the Vite landing page. Only needed when touching `web/`.
- Dictation needs a Whisper-compatible HTTP endpoint. Default is `http://localhost:8080/inference`. The app does not start Whisper; keep your local whisper.cpp (or other) server running separately.
- Agent Mode needs an OpenAI-compatible provider. API keys live in environment variables; only the env-var *name* is stored in config. If Agent Mode fails at runtime, check Settings and the process environment before digging into code.
- Do not run `bun run build`, `bun run build:agent`, or `bun run dist` during normal feature work. Those are for packaging checks, not day-to-day iteration.
- Stop what you started, by the PID you tracked. Do not kill Electron/Vite by name pattern — this machine may have other instances running.



## Verifying

- Smallest proof that the change works. Prefer `bun test <path>` for the files you touched (tests live under `app/src/**/__tests__/` and `app/scripts/__tests__/`). Run targeted `bun run --cwd app lint` / `bun run --cwd app typecheck` only when the change warrants it.
- **Do not run repo-wide checks by default.** No root `bun run lint`, `bun run typecheck`, or full `bun test` unless I ask. CI on `windows-latest` owns the full suite.
- Behavior changes in main, sidecar, IPC, MCP, approvals, or config should ship with focused Bun tests for that behavior.
- Prefer deterministic unit/integration tests over sleeps. For sidecar protocol and agent-run flows, assert on typed messages / `agentRunId` correlation and terminal run states — never race the UI with arbitrary timeouts.
- Dictation and Agent Mode stay separate intents. A Dictation-only change must not require Agent Mode to be enabled to verify; an Agent Mode change must not break users who only dictate.
- Upon request, user-visible UI changes get one integrated pass in the real Electron app (`bun run dev`). Do not launch browsers or computer-use sessions unless I explicitly ask. Subagents do not start their own Electron instances.
- Skip packaging verification (`bun run build` / `bun run dist`) unless the change is specifically about build, updater, or release artifacts.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(app): recording pill no longer spikes CPU while idle`.
- Body: the problem in a sentence or two, then how you fixed it. Call out config, storage, IPC, MCP, OAuth, or native Windows behavior changes when relevant. End with the model and harness that did the work.
- **Rebase onto latest main before opening.** Stale branches conflict and burn a review round.
- UI changes need before/after images. Motion or timing needs a short video.
- One concern per PR. If the description says "also", split it.
- Add user-visible changes under `## Unreleased` in `app/CHANGELOG.md` when appropriate. Changelog is project history, not the release-notes authority — GitHub release notes come from git history between tags.
- Do not bump the committed `package.json` version for ordinary PRs. Release versions come only from human-approved `vX.Y.Z` tags.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## How it works

Global hotkeys start a **recording session** (Dictation or Agent Mode). Audio is captured in a hidden renderer window, the **recording pill** shows live levels, and on end the WAV is sent to the configured **Whisper** endpoint.

For **Dictation**, the transcript is injected into the focused app via the clipboard-sandwich paste path.

For **Agent Mode**, Electron main hands the transcript to the **sidecar** over a stdio JSONL protocol (`agentRunId` on every run-scoped message). The sidecar runs a Vercel AI SDK loop against the configured OpenAI-compatible **provider**, optionally calling tools from connected **MCP** servers. Sensitive tools surface as **approval toasts**; status and the final answer appear as toasts. The sidecar writes a local SQLite **audit** trail; Electron main owns windows, config, tray, and approval UI.

Agent Mode is opt-in, single-flight, and stateless by default: one spoken command → one run → done. Disabling Agent Mode stops the sidecar and MCP connections.

Deeper product/architecture language lives in `app/CONTEXT.md` and `app/docs/adr/`.

## Where code lives

- `app/` — the Windows Electron product. Almost all feature work happens here.
- `app/src/main/` — Electron main process: tray, hotkeys, windows, Whisper client, text injection, config, sidecar lifecycle, approval routing.
- `app/src/renderer/` — React UI: recording pill, settings window, agent toasts, hidden audio capture window.
- `app/src/preload/` — typed IPC bridge exposed to the renderer.
- `app/src/types/ipc.ts` — shared IPC channels and config shapes. Update this whenever IPC or persisted config changes, and keep preload + main handlers in sync.
- `app/src/agent/` — agent sidecar: AI SDK runtime, MCP registry/clients, OAuth helpers, JSONL protocol, SQLite audit log.
- `app/src/shared/` — small shared helpers used across process boundaries (e.g. shortcut bindings, audit DB helpers).
- `app/CONTEXT.md` — durable product/architecture decisions and domain language. Update when behavior or boundaries change meaningfully.
- `app/docs/adr/` — architecture decision records for larger choices.
- `web/` — React/Vite marketing/landing site. Keep product behavior changes out of here unless the task is explicitly about the site.
- Root `package.json` — Bun workspaces (`app`, `web`) and monorepo scripts.

## Taste

- Complexity belongs at the edges: native Windows hooks, Whisper/provider clients, and the MCP/sidecar boundary. Electron main stays a thin orchestrator; UI stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. Prefer short notes on functions and seams, not play-by-play of every line.
- Users live in other apps all day. They notice a sticky recording pill, a lying toast, a missed hotkey, or a paste that clobbers the clipboard. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.
