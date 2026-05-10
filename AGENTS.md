# AGENTS.md — Shuddhalekhan

## Platform
- **Windows-only**. The app uses `koffi` to call `user32.dll` / `kernel32.dll` for global keyboard hooks and clipboard paste simulation. Will not run on macOS/Linux.

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
- **electron-vite** with three targets defined in `electron.vite.config.ts`:
  - `main` — entry `src/main/index.ts`, output CJS (`out/main/index.cjs`)
  - `preload` — entry `src/preload/index.ts`, output CJS (`out/preload/index.cjs`)
  - `renderer` — Vite + React, entry `src/renderer/main.tsx`, alias `@renderer` → `src/renderer/`

## IPC
- All IPC channel types are in `src/types/ipc.ts`. Channels must stay in sync between `src/preload/index.ts` and `src/main/index.ts`.
- Pattern: `invoke` for request/response, `send`/`on` for events.
- Preload exposes `window.electronAPI` with typed `invoke`, `send`, `on`.

## Native layer
- `src/main/native/keyboard.ts` — global low-level keyboard hook via `koffi`. Ctrl+Win chord toggles recording.
- `src/main/native/clipboard.ts` — `SendInput`-based Ctrl+V paste simulation via `koffi`.

## Config
- `electron-store` with store name `shuddhalekhan-config`.
- Legacy config path `~/.speech-2-text/config.json` is auto-migrated on first run (see `src/main/config.ts`).

## Lint rules
- `@typescript-eslint/no-unused-vars` is error-level with `argsIgnorePattern: '^_'`.
- `@typescript-eslint/no-explicit-any` is off.
- `out/`, `release/`, `node_modules/`, and generated shadcn UI components are ignored.

## Tests
- Bun tests live under `src/**/__tests__/`.
- Run lint, typecheck, and `bun test` as pre-commit verification.

## Pre-PR Opening Checklist
- [ ] Make sure `@package.json` version is updated, ensuring propery version number upgrade to reflect the severity of the changes being made.
- [ ] Make sure `@release-notes.md` is updated to reflect the changes being made.
