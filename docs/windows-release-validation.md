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

- Trigger Dictation with `Ctrl + Win` and Agent Mode with `Alt + Win`.
- Dictate into a target Windows text application and verify clipboard-backed
  paste inserts the transcript.
- Complete an Agent request and verify sidecar startup, streamed response
  text, audit persistence, tool discovery/execution, and an approve/deny
  cycle.
- Verify a direct HTTP MCP server works normally and a redirecting server is
  denied unless that server has explicitly opted in to redirects.

Local packaging proves package construction and the checks above; it does not
prove release publication or an end-to-end auto-update. Publishing remains
gated on a separately human-approved release tag.
