# AGENTS.md — Shuddhalekhan

## Platform
- **Windows-only**. The app uses `koffi` to call `user32.dll` / `kernel32.dll` for global keyboard hooks and clipboard paste simulation. Will not run on macOS/Linux.

## Monorepo
- `app/` contains the Electron desktop application.
- `web/` contains the Vite/React landing page.
- Run workspace-wide checks from the repository root. Run app-specific commands from `app/` when working only on the desktop application.

## Commands
| Purpose     | Command                          |
|-------------|----------------------------------|
| Dev         | `bun run dev`                    |
| Typecheck   | `bun run typecheck`              |
| Lint        | `bun run lint`                   |
| Lint fix    | `bun run lint:fix`               |
| Test        | `bun test`                       |
| Install     | `bun install`                    |

Use `bun` exclusively. `pnpm` is only a fallback if `koffi` causes resolution issues.

**Never run build commands (`bun run build`, `bun run build:agent`, etc.) unless explicitly asked.** Build outputs are ephemeral and should not be committed. Delete any build artifacts created inadvertently before proceeding.

## Build architecture
- **electron-vite** with three targets defined in `app/electron.vite.config.ts`:
  - `main` — entry `src/main/index.ts`, output CJS (`out/main/index.cjs`)
  - `preload` — entry `src/preload/index.ts`, output CJS (`out/preload/index.cjs`)
  - `renderer` — Vite + React, entry `src/renderer/main.tsx`, alias `@renderer` → `src/renderer/`

## IPC
- All IPC channel types are in `app/src/types/ipc.ts`. Channels must stay in sync between `app/src/preload/index.ts` and `app/src/main/index.ts`.
- Pattern: `invoke` for request/response, `send`/`on` for events.
- Preload exposes `window.electronAPI` with typed `invoke`, `send`, `on`.

## Native layer
- `app/src/main/native/keyboard.ts` — global low-level keyboard hook via `koffi`. Ctrl+Win chord toggles recording.
- `app/src/main/native/clipboard.ts` — `SendInput`-based Ctrl+V paste simulation via `koffi`.

## Config
- `electron-store` with store name `shuddhalekhan-config`.
- Legacy config path `~/.speech-2-text/config.json` is auto-migrated on first run (see `app/src/main/config.ts`).

## Lint rules
- `@typescript-eslint/no-unused-vars` is error-level with `argsIgnorePattern: '^_'`.
- `@typescript-eslint/no-explicit-any` is off.
- `out/`, `release/`, `node_modules/`, and generated shadcn UI components are ignored.

## Tests
- Bun tests live under `app/src/**/__tests__/`.
- Run lint, typecheck, and `bun test` as pre-commit verification.

## Pre-PR Opening Checklist
- [ ] Add user-visible desktop changes to `app/CHANGELOG.md` under `Unreleased` when appropriate.
- [ ] Do not change the neutral development version in `app/package.json`; release versions come exclusively from human-approved Git tags.
- [ ] Do not create, move, delete, or push release tags without explicit user approval.
