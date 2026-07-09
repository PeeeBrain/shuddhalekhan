# Contributing to Shuddhalekhan

Shuddhalekhan is a Windows-only Electron app. Use `bun` for all project commands.

## Local Setup

Install dependencies:

```bash
bun install
```

Run the app in development mode:

```bash
bun run dev
```

The app needs a Whisper-compatible transcription endpoint. The default endpoint is:

```text
http://localhost:8080/inference
```

## Adding Features

Keep changes aligned with the app boundaries:

- `src/main/` owns Electron lifecycle, tray, hotkeys, windows, Whisper transcription, config, and text injection.
- `src/renderer/` owns React UI, including the settings window, recording pill content, and agent toasts.
- `src/preload/` owns the typed IPC bridge exposed to renderer code.
- `src/types/ipc.ts` owns shared IPC and app config types. Update it whenever IPC channels or config shapes change.
- `src/agent/` owns Agent Mode sidecar behavior: Vercel AI SDK runtime, MCP registry, OAuth, protocol handling, and audit logging.

For user-facing feature work:

1. Update the UI and behavior together. Avoid adding hidden config that cannot be managed from Settings unless it is intentionally internal.
2. Add focused Bun tests under `src/**/__tests__/` for new behavior.
3. Keep Dictation and Agent Mode as separate recording intents. `Ctrl+Win` is Dictation; `Alt+Win` is Agent Mode.
4. Keep secrets out of persisted config. Store environment variable names, not API key values.
5. Keep all IPC channels typed and synchronized across `src/types/ipc.ts`, `src/preload/index.ts`, and the relevant main-process handlers.
6. Do not commit generated outputs from `out/`, `release/`, or `node_modules/`.

## Agent Mode Changes

Agent Mode is opt-in and should not affect users who only use Dictation.

When changing Agent Mode:

- Preserve the sidecar boundary. Electron main should coordinate windows, config, and approval decisions; `src/agent/` should own model, MCP, OAuth, and audit behavior.
- Ensure every run-scoped sidecar message carries `agentRunId` so stale events can be ignored.
- Default newly discovered MCP tools to `alwaysAsk`.
- Keep tool approvals explicit, auditable, and cancellable.
- Update `CONTEXT.md` or `docs/adr/` when a change affects architecture or product decisions, not just implementation details.

## Checks Before Opening a PR

Run these before opening a pull request:

```bash
bun run lint
bun run typecheck
bun test
```

CI runs the same checks on `windows-latest`, then verifies Electron native dependencies with:

```bash
bun x electron-builder install-app-deps
```

Do not run build commands such as `bun run build`, `bun run build:agent`, or `bun run dist` during normal feature work unless you specifically need to test packaging. Build outputs are ephemeral and should not be committed.

## Pull Request Expectations

A good PR should include:

- A concise description of the user-facing change.
- Notes about any config, storage, IPC, OAuth, MCP, or native Windows behavior changes.
- Screenshots or short notes for visible UI changes.
- Test coverage for changed behavior, or a clear reason why tests were not practical.
- Confirmation that lint, typecheck, and tests passed.

## Version and Release Updates

Only bump versions when preparing a release.

For a release PR:

1. Update `version` in `package.json`.
2. Run `bun install` so `bun.lock` reflects the package version change if Bun updates lockfile metadata.
3. Move the finalized user-visible changes from `## Unreleased` into a matching `## vX.Y.Z` section in `CHANGELOG.md`.
4. Make sure README or other user-facing docs describe any new major behavior.
5. Run the PR checks:

```bash
bun run lint
bun run typecheck
bun test
```

After the release PR has merged and CI is green, a human explicitly creates and pushes the matching tag. For example, package version `4.0.0` maps to `v4.0.0`. That tag is the only release trigger; ordinary pushes to `main` never publish a release.

Follow [docs/releasing.md](docs/releasing.md) for the complete runbook. Creating, moving, deleting, or pushing release tags is a human-in-the-loop action and requires explicit approval.

## Build and Packaging

Packaging is handled by GitHub Actions on Windows after a release tag is pushed. The release workflow runs:

```bash
bun run build
bun run dist -- --publish always
```

Run these locally only when you are deliberately testing packaging. If local build artifacts are created, remove them before committing unless the project explicitly starts tracking a new generated asset.
