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
bun run check
```

Typechecking uses TypeScript 7.0.2 throughout the monorepo. Oxlint runs the
existing workspace lint checks without depending on the legacy compiler API.
The check command runs typechecking, linting, and tests together. Tests run in
four isolated worker processes; use `bun run test` to run just the tests.

See [`app/README.md`](app/README.md) for desktop application details.
