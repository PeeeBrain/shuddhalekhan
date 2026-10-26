# Shuddhalekhan

Shuddhalekhan is organized as a Bun monorepo with three workspaces:

- `app/` — the Windows Electron speech-to-text application.
- `web/` — the React landing page.
- `mobile/` — the standalone React Native/Expo iOS app. See [mobile setup and Sideloadly builds](mobile/README.md).

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

Desktop and web typechecking use TypeScript 7.0.2. Mobile uses Expo's recommended
TypeScript version. Oxlint runs the
existing workspace lint checks without depending on the legacy compiler API.
Workspaces share React 19.3 to match Expo's native renderer. Bun uses a hoisted
dependency layout so Expo autolinks one copy of each native module.
The check command runs typechecking, linting, and tests together. Tests run in
four isolated worker processes; use `bun run test` to run just the tests.

See [`app/README.md`](app/README.md) for desktop application details.

## Mobile verification

Run focused mobile tests and the mobile typecheck/lint commands in [the mobile verification guide](mobile/README.md#verification). For native or keyboard changes, build a Release IPA with Expo EAS, share its download link, and install it on the USB-connected iPhone with iLoader or Sideloadly, retaining the keyboard extension.

Verify the installed build number, capture filtered device logs, and reproduce the change on the phone. For keyboard dictation, start a session in the app, switch to Notes, Dictate, speak, then Stop and insert. Confirm text appears exactly once, then try another utterance and another app. The guide includes the PowerShell USB capture commands, expected connection/recording/transcription events, and startup timing checks. Local JavaScript checks alone cannot verify iOS background recording.
