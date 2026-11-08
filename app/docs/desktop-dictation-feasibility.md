# Desktop Dictation feasibility evidence

Stage 0 evidence for [#240](https://github.com/PeeeBrain/shuddhalekhan/issues/240), following `desktop-dictation-overhaul-plan.md`. This file records what has been observed and lists the gates still open. **It certifies nothing.** Seeing a portal interface on the bus does not prove that automatic insertion works.

The maintainer has selected previews plus final insertion and requires the original input context on Wayland. See [ADR 0004](adr/0004-desktop-dictation-context-and-final-delivery.md). Portal paste into the current focus is therefore insufficient as the primary Wayland backend. The portal results below remain activation/setup diagnostics; input-method feasibility is the next delivery gate.

## Preflight diagnostic

```sh
cd app
bun scripts/desktop-dictation-preflight.ts          # human-readable
bun scripts/desktop-dictation-preflight.ts --json   # for attaching to evidence
```

The parser tests run normally. The tests that start subprocesses are opt-in:

```sh
SHUDDHALEKHAN_PREFLIGHT_INTEGRATION=1 bun test scripts/__tests__/desktop-dictation-preflight.test.ts
```

What it reports:

- OS, architecture, and kernel.
- Bun and Node versions, and the installed Electron version from `node_modules/electron/package.json`.
- On Linux: `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`, and `XDG_SESSION_DESKTOP`. For `WAYLAND_DISPLAY`, `DISPLAY`, and the session bus address it records only whether each is set.
- Whether `shuddhalekhan.desktop` is installed in the XDG data dirs.
- `version` for the GlobalShortcuts, RemoteDesktop, Clipboard, InputCapture, and ScreenCast portals, plus RemoteDesktop `AvailableDeviceTypes`.

How it behaves:

- Each property is read with one `busctl --user --auto-start=no get-property` call. It uses a fixed argv with no shell, a fixed output locale, a bounded output buffer, and a 3 s timeout, killing busctl on timeout.
- It creates no portal sessions and opens no dialogs. It sends no input and does not read the clipboard, audio, or secrets.
- `--auto-start=no` means a portal that isn't running yet shows as `portal-not-running`. The probe does not start it.
- Failures show as a status rather than an exception: `missing-interface`, `missing-property`, `portal-not-running`, `no-session-bus`, `busctl-missing`, `timeout`, or `error`.
- On Windows and macOS the portal probe is skipped.
- Importing the module does not run the CLI.

Not covered: systems without `busctl` (no gdbus fallback), portal backend package versions (these are distro-specific, so record them by hand), and the desktop-file association the portal actually uses for a running app.

## Observed: Fedora 45 KDE Plasma Wayland (2026-11-06)

Environment: kernel 7.2.15-300.fc45.x86_64, Plasma 6.8.2, `xdg-desktop-portal-1.22.1-2.fc45`, `xdg-desktop-portal-kde-6.8.2-1.fc45`, busctl from systemd 262. Portal preference is `default=kde` from `/usr/share/xdg-desktop-portal/kde-portals.conf`. Installed Electron is 43.1.0, and the app was not launched.

```
Session: type=wayland desktop=KDE WAYLAND_DISPLAY=set DISPLAY=set
Desktop entry shuddhalekhan.desktop: not installed in XDG data dirs
  GlobalShortcuts.version: 2
  RemoteDesktop.version: 2
  RemoteDesktop.AvailableDeviceTypes: 7 [keyboard, pointer, touchscreen]
  Clipboard.version: 1
  InputCapture.version: 2
  ScreenCast.version: 6
```

A `gdbus call … org.freedesktop.DBus.Properties.Get` cross-check returned the same RemoteDesktop `AvailableDeviceTypes` value (`<uint32 7>`). When the probe ran with a scrubbed environment (no session bus), every portal reported `no-session-bus`.

What this shows: KDE's portal backend exposes the inspected interfaces. It does **not** show that a keyboard-only RemoteDesktop session can be granted or persisted, that the Clipboard portal can attach to that session, or that a paste chord lands in any target app. Even successful portal paste would not satisfy the selected original-context requirement.

## Known limits that affect the candidate

- **The app currently runs as an XWayland client.** Both `dev` and the packaged Linux `executableArgs` pass `--ozone-platform=x11`. On a Wayland session, Shuddhalekhan's own windows and any X11-side probes therefore see XWayland, not the native compositor. Native Wayland target apps are a separate case from XWayland ones, and passing on XWayland only does not close the gate.
- **Desktop identity.** `package.json` sets `desktopName: shuddhalekhan.desktop` with `syncDesktopName`, but nothing is installed on this machine yet. The app ID the portal uses for a host (non-Flatpak) Electron 43.1.0 process depends on the installed `.desktop` file and on how the backend derives app IDs from the process. Verify this against a deb/rpm install. Do not infer it from config.
- **Wayland focus is unknown to these portals.** A portal paste reaches whatever has focus when it is dispatched. That is insufficient under ADR 0004. An input-method probe must prove context lifetime, invalidation, and app coverage, including input-context reuse across different fields.
- **The Clipboard portal depends on a consented session.** It extends a RemoteDesktop (or similar) session; it is not a standalone clipboard permission. Clipboard version 1 being visible says nothing about whether the user will grant the session.
- **Hold-to-talk needs proof of release.** Treat GlobalShortcuts `Activated`/`Deactivated` as candidates. Allow a hold binding only on desktops where a real release event has been observed. Otherwise offer toggle only.

## Remaining manual certification gates

Each gate needs a recorded run with the environment details above. Each must show automatic insertion into an editor, a browser field, a terminal, and an Electron app, and cover Unicode, selection replacement, held modifiers, a focus switch during staging, and a user copy during staging/restore. A mock, a Copy fallback, or an XWayland-only target does not count.

| Environment | Open gate |
| --- | --- |
| Windows | Clipboard + SendInput delivery with real target identity; elevated-target failure reported honestly; registered chord vs. hook for hold release |
| GNOME Wayland | Run this preflight; prove original-context input-method commit, invalidation on focus/reset/disable, compatibility with ordinary typing, and GlobalShortcuts release events |
| KDE Plasma Wayland | Portal interfaces observed above; original-context input-method integration and activation remain unproven, as on GNOME |
| X11 (real session, not XWayland) | Native grab with release events; XTest dispatch with X11 focus identity; selection-ownership tracking; restoring without uinput |

The exit gate is the one in the plan's Stage 0 section: automatic insertion demonstrated in all four environment classes, with focus and clipboard limitations the maintainer accepts.

Additional read-only observations after the delivery decision: IBus 1.5.35rc1 and its Python GI bindings are installed, but the IBus session-bus service is only activatable, not running. Fcitx5 is not installed. KWin's configured input method is `/usr/share/applications/org.kde.plasma.keyboard.desktop`. No daemon was started and no input-method setting was changed. These facts permit building a probe, not certifying an active IBus integration on this desktop.

The IBus probe found no running daemon and did not start one. A local engine token cannot provide the missing receiver validation. The completed probe and experiment files were archived outside the repository and removed from the app workspace.

The [receiver source investigation](receiver-context-feasibility.md) is complete for the named stock paths. The inspected KWin 6.8.2 handler ignores the supplied commit serial; GNOME's inspected stock path queues commits without the session's original-context token. wlroots has stale-serial rejection on one protocol hop, but no end-to-end backend is certified and that finding does not satisfy GNOME/KDE coverage. These findings led to the maintainer's decision to investigate strict receiver integrations. No host compositor packages or desktop settings were changed.

The [receiver findings](receiver-context-feasibility.md) record the completed native tests and 14 real Shell-to-GTK fixture checks, including an exact-pin unpatched comparison that reproduces wrong-field insertion. Host packages and desktop settings remain unchanged. General application coverage, ordinary IME compatibility, and toolkit protocol agreement remain open; this does not close Stage 0.
