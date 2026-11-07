# Shuddhalekhan

Shuddhalekhan is organized as a Bun monorepo with two workspaces:

- `app/` — the Electron speech-to-text application (Windows, plus Linux deb/rpm).
- `web/` — the React landing page.

## Linux

Install the `.deb` (Ubuntu, Debian) or `.rpm` (Fedora, RHEL). Desktop shortcuts use X11 key grabs on X11 and the GlobalShortcuts portal on Wayland. Settings shows the actual assigned trigger and whether text insertion is available. A portal may ask you to choose a shortcut; modifier-only bindings have no portable portal representation.

On X11, final insertion checks the original focused window and process, uses the server's keymap for the paste chord, and tracks clipboard ownership changes with XFixes. It does not verify individual fields within a window. Unsupported clipboard formats block automatic paste rather than being discarded. Newer clipboard copies take precedence over restoration.

**KDE Wayland has an opt-in best-effort insertion test mode.** In Settings → Transcription → Wayland text insertion, enable **Best-effort insertion (test mode)** and grant KDE's separate keyboard-control prompt. Shortcut permission alone does not authorize insertion. The mode pins the original window and aborts on observed window changes, but cannot detect a different field inside that window or close the final focus race. It puts the transcript on the clipboard and leaves it there. Consent is requested again on each launch while enabled. Start testing in an ordinary editor or browser field; terminals may need a `ctrl-shift-v` paste override. Other Wayland desktops remain copy-only, and strict original-field delivery is still unavailable. See [receiver findings](app/docs/receiver-context-feasibility.md). Agent Mode does not depend on text insertion.

If the desktop shortcut API is unavailable, the legacy input-device reader is a fallback. Only that fallback needs membership in the `input` group, and its keys also reach the focused app:

```bash
sudo usermod -aG input $USER   # then restart; logging out often keeps the old groups
```

The desktop entry and `bun run dev` pass `--ozone-platform=x11`, so the recording pill and toasts run under XWayland. That keeps them pinned bottom-center, above other windows, and shown without taking focus. Electron 43.1 has no native Wayland API for any of this: no layer-shell surface, and `setPosition`, `moveTop` and `showInactive` are unsupported there. Launching the `shuddhalekhan` binary directly, without the flag, uses native Wayland (Electron's default). In that mode the compositor decides where the pill and toasts appear and whether they stay on top or take focus. Native Wayland is unsupported for overlays; launch from the desktop entry. Portal activation and the copy-only Wayland transcript path work with either window backend. Dev mode temporarily registers a hidden desktop identity if no installation exists, and removes its own file on quit. Linux paste no longer uses `/dev/uinput`; the old app-specific udev rule is removed from new packages. An upgrade does not remove your input-group membership. GPU (CUDA) local models remain Windows-only; GNOME needs the AppIndicator extension for the tray icon.

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
