# Windows release validation

This document records the repeatable local packaging checks used for release
candidate validation. It does not publish a release, create a tag, or prove
end-to-end auto-update delivery.

## Local package command

Run from a clean Windows checkout with the supported Bun and Node versions:

```powershell
bun run typecheck
bun run lint
bun test
bun run build
bun run dist -- --publish never
```

The package command must leave `release/` untracked. Inspect the generated
NSIS installer, its blockmap, and `release/latest.yml`; do not commit any of
those generated files.

## Packaged native-runtime probe

Install the generated NSIS installer into a disposable directory, start the
installed application, and use its bundled Electron executable with
`ELECTRON_RUN_AS_NODE=1` to verify the packaged runtime can load `koffi` and
`better-sqlite3`. The probe must create a temporary audit SQLite database,
write a known value, read it back, and close it successfully.

The Agent sidecar is bundled at `resources/app.asar/out/agent/index.js` and
is started by the application with the installed Electron runtime in Node mode
(`ELECTRON_RUN_AS_NODE=1`).

## 2026-07-13 local evidence (#110)

- `bun run typecheck`, `bun run lint`, and `bun test` passed (232 tests).
- `bun run dist -- --publish never` produced an x64 NSIS installer, blockmap,
  unpacked Windows application, and `latest.yml` using Electron `43.1.0` and
  electron-builder `26.15.6`.
- The installer completed successfully in a disposable workspace-local
  directory; the installed app remained running for an eight-second launch
  smoke check.
- The installed Electron runtime reported `43.1.0`; it loaded packaged
  `koffi`, then loaded packaged `better-sqlite3` and persisted/read the known
  audit value `persisted`.
- The package, installer, and temporary installed application were not
  committed.

## Interactive release smoke checklist

Before a human-approved tagged release, run this checklist against a configured
provider and both a stdio and direct HTTP MCP server:

- Confirm the default `Ctrl + Win` Dictation and `Alt + Win` Agent Mode bindings, then capture representative single-key, ordinary-chord, and modifier-only replacements in Settings.
- Verify Push to Talk and Toggle independently for both intents, including repeat suppression, trigger consumption, dormant disabled Agent Mode, live config changes, and Escape/focus-loss capture cleanup.
- Pause global shortcuts from Settings and the tray. Confirm new sessions are blocked, an active session still finishes normally, configured keys pass through while paused, and pause resets after restart.
- Dictate into a target Windows text application and verify clipboard-backed
  paste inserts the transcript.
- Complete an Agent request and verify sidecar startup, streamed response
  text, audit persistence, tool discovery/execution, and an approve/deny
  cycle.
- Verify a direct HTTP MCP server works normally and a redirecting server is
  denied unless that server has explicitly opted in to redirects.
- Verify Windows DPAPI-backed transcription and Agent credentials survive restart without appearing in renderer config, logs, notifications, errors, or audit output.
- Verify local whisper.cpp transcription and representative authenticated-provider validation/failure paths without submitting billable test audio.

Local packaging proves package construction and the checks above; it does not
prove release publication or an end-to-end auto-update. Publishing remains
gated on a separately human-approved release tag.

## 2026-07-13 completed-stack evidence (#113)

The completed Electron 43 and AI SDK 7 stack was validated on Windows with Bun
`1.3.14` and host Node `24.16.0`:

- `bun run typecheck`, `bun run lint`, and all 243 tests passed.
- `out/` and `release/` were removed before `bun run build` and
  `bun run dist -- --publish never`, ensuring the package contained the current
  AI SDK 7 runtime and MCP redirect-policy changes rather than earlier output.
- electron-builder `26.15.6` rebuilt `better-sqlite3` for Electron `43.1.0`
  x64 and produced the NSIS installer, blockmap, unpacked app, and `latest.yml`.
- The completed-stack installer size was 131,571,355 bytes and its
  `latest.yml` SHA-512 value was
  `IGdyg6VuCm1UDk1ozUJsruDXCXA/URNjtg3l3Z5Q7O6Hplt3NksZTl33REnXp7Gn68Sej7HHc/RlMiknCQjCBQ==`.
- A disposable installation launched successfully and remained healthy for an
  eight-second process check.
- The installed Electron runtime reported Electron `43.1.0` and bundled Node
  `24.18.0`, loaded packaged `koffi`, and persisted/read the SQLite audit value
  `completed-stack` through packaged `better-sqlite3`.
- The packaged Agent sidecar started through Electron's bundled Node mode and
  emitted `{"type":"sidecar:ready","protocolVersion":1}`.
- Automated behavior coverage exercised Dictation and Agent Mode hotkey
  routing, clipboard injection/restoration, Agent streaming, sequential tool
  approval and denial continuation, audit persistence, stdio MCP construction,
  direct HTTP MCP, OAuth-backed HTTP MCP, redirect denial, explicit redirect
  following, and connection recreation after policy changes.
- `.github/workflows/ci.yml` remains a frozen-lockfile Windows verification
  workflow with Electron native dependency rebuilding. The tag-gated
  `.github/workflows/release.yml` reruns checks, builds, publishes with
  electron-builder, and finalizes release metadata.

The remaining release risks are interactive integration and delivery checks:
the packaged hotkeys, microphone/Whisper path, clipboard injection into a real
target application, configured external provider, and user-selected MCP
servers still require the human smoke checklist above. Local validation also
does not prove GitHub publication or end-to-end auto-update delivery. Those
steps remain gated on a separately approved release tag; this validation did
not create, move, delete, or push any tag.
