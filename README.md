# Shuddhalekhan

Shuddhalekhan is organized as a Bun monorepo with two workspaces:

- `app/` — the Windows Electron speech-to-text application.
- `web/` — the React landing page.

## Setup

Install all workspace dependencies from the repository root:

```powershell
bun install
```

Run the desktop application:

```powershell
bun run dev:app
```

Run the landing page:

```powershell
bun run dev:web
```

Run repository checks:

```powershell
bun run typecheck
bun run lint
bun test
```

See [`app/README.md`](app/README.md) for desktop application details.
