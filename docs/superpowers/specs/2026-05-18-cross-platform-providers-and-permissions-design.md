# Cross-Platform Providers and Permissions Design

## Purpose

Shuddhalekhan should add macOS and Linux support through platform providers with explicit capability reporting, not by pretending all operating systems expose the same input, clipboard, tray, and permission APIs.

This spec covers platform support boundaries, validation targets, permission handling, and dependency strategy.

## Provider Boundaries

Platform-specific behavior should sit behind narrow providers:

- Shortcut trigger provider: registers or configures global Dictation and Agent Mode triggers.
- Text injection provider: performs clipboard sandwich and paste simulation.
- Capability provider: reports whether required platform features are ready, blocked, unsupported, or need setup.

The providers adapt platform events into existing app behavior. They must not own transcription, agent routing, or the recording lifecycle.

The current Windows `koffi` implementation remains the Windows implementation detail for the first cross-platform pass. Replacing it with Electron APIs is explicitly future work.

## Linux Target

Linux support is Wayland-first, with X11 as a compatibility fallback.

Initial package target:

- Debian/Ubuntu `.deb`.

Initial desktop validation target:

- GNOME on Wayland.

Compatibility and community validation targets:

- X11 fallback.
- KDE Wayland.
- wlroots compositors.
- Sway.
- Hyprland.
- Other desktop environments.

Linux release notes must not imply uniform Wayland support across all compositors.

## Linux Shortcut Setup

Every supported OS must provide a global hotkey path. On GNOME Wayland and similar desktops, user-mediated shortcut setup is acceptable when direct app registration is unavailable.

Settings should treat this as first-class setup work:

- Show that the shortcut needs setup.
- Explain the desktop-approved setup path.
- Provide copyable or deep-link instructions where available.
- Detect completion where possible.
- Keep the shortcut unassigned until setup succeeds.

The first cross-platform pass should not expose a user-facing CLI action interface such as `shuddhalekhan --action dictation-toggle`. Avoiding CLI integration keeps the support surface focused.

Linux may ship as Experimental with incomplete desktop integration if capability reporting is honest. It must not show Dictation as ready when global shortcuts or paste injection are unavailable.

Linux must not be promoted beyond Experimental until GNOME Wayland has:

- A working global shortcut path.
- A focused-app injection story.
- Real desktop validation beyond WSL.

WSL is useful for Linux-adjacent checks such as tests, typecheck, package resolution, and headless experiments. It is not sufficient validation for Linux Dictation.

## macOS Target

macOS support is staged:

- macOS CI can produce unsigned `.dmg`/`.zip` artifacts for smoke testing and community validation.
- Unsigned artifacts may be published only as Experimental or Developer Preview builds.
- Stable macOS support requires signing and notarization.

The first macOS shortcut implementation should use Electron's standard global shortcut capability where possible. Native macOS event taps are deferred until validation proves they are necessary.

macOS providers must report permission/capability state clearly for:

- Microphone permission.
- Accessibility permission.
- Automation or paste simulation permission, if applicable.
- Global shortcut registration failures.

No stable macOS support claim should be made until signing, notarization, and real permission-flow validation are complete.

## Dependency Strategy

Avoid adding new native dependencies until a specific platform gap requires one.

Initial strategy:

- Windows: keep `koffi`.
- macOS: start with Electron APIs and minimal OS integration.
- Linux: start with Electron APIs and desktop/portal integration where available.
- New native modules must live behind platform-specific provider files.
- Any new native dependency needs a concrete justification tied to a platform capability gap.

This keeps the first cross-platform pass from becoming dependency churn or a Windows internals refactor.

## Capability Reporting

Settings and tray/status UI should expose capability state per action and per platform feature:

- Shortcut ready.
- Shortcut unassigned.
- Shortcut needs setup.
- Shortcut unsupported on this desktop/session.
- Paste injection ready.
- Paste injection blocked by permission.
- Paste injection unsupported on this desktop/session.

Capability reporting must be honest. Experimental builds can be useful even with gaps, but the app must not imply full Dictation readiness when required capabilities are absent.

## Out Of Scope

This spec does not include:

- User-facing CLI action integration.
- Replacing Windows `koffi`.
- Stable macOS signing/notarization implementation details.
- Flatpak/Snap-specific permission models.
- Claiming broad Linux Wayland support beyond validated desktops.

## Testing Requirements

Automated tests should cover provider selection and capability mapping:

- Windows uses the existing Windows provider.
- macOS selects the macOS provider without importing Windows-only native modules.
- Linux selects the Linux provider without importing Windows-only native modules.
- Unsupported capability states are surfaced to settings/tray status.
- Experimental platform gaps do not mark Dictation as ready.

Manual validation is required for:

- Global shortcut registration.
- Desktop-mediated shortcut setup.
- Focused-app paste injection.
- Tray behavior.
- Microphone permission UX.
- macOS Accessibility/Gatekeeper behavior.
- GNOME Wayland and X11 behavior.
