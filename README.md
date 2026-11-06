# Shuddhalekhan

Shuddhalekhan is organized as a Bun monorepo with two workspaces:

- `app/` — the Electron speech-to-text application (Windows, plus Linux deb/rpm).
- `web/` — the React landing page.

## Linux

Install the `.deb` (Ubuntu, Debian) or `.rpm` (Fedora, RHEL) from the latest release. Shortcuts read the keyboard through `/dev/input` and paste through a `/dev/uinput` virtual keyboard, so your user must be in the `input` group:

```bash
sudo usermod -aG input $USER   # then restart; logging out often keeps the old groups
```

Works on X11 and Wayland. The app runs under XWayland (`--ozone-platform=x11`, passed by the desktop entry and `bun run dev`) so the recording pill and toasts can position themselves. Pass it yourself when launching the binary directly. Linux limitations: shortcut keys are not swallowed, so they also reach the focused app; Live Dictation inserts the final transcript instead of typing as you speak; per-app paste strategies use the default; the focused window cannot be inspected, so a paste lands wherever focus is when transcription finishes; paste sends the physical Ctrl+V keys, so on non-QWERTY layouts (such as Dvorak) set the default paste strategy to Shift+Insert; GPU (CUDA) local models are Windows-only; GNOME needs the AppIndicator extension for the tray icon.

Build the packages locally (Fedora needs `gcc-c++ make rpm-build libxcrypt-compat`; Ubuntu needs `build-essential rpm`):

```bash
bun install
bun run --cwd app build
bun run --cwd app dist -- --linux deb rpm --publish never
```

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
