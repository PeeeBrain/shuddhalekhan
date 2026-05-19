# Cross-Platform Packaging and CI Design

## Purpose

Shuddhalekhan should produce platform-specific release artifacts from the same source tree while keeping release gates scoped per platform. Windows remains the current stable platform. Linux and macOS can publish experimental artifacts while their desktop integrations mature.

This spec covers packaging targets, CI topology, release gating, and release labeling. It does not cover shortcut implementation details or permission-provider internals.

## Packaging Targets

Each OS needs its own release artifact. The current Windows `.exe` installer cannot run on macOS or Linux.

Initial targets:

- Windows: existing NSIS installer, Stable.
- Linux: Debian/Ubuntu `.deb`, Experimental.
- macOS: unsigned `.dmg`/`.zip`, Experimental or Developer Preview.

Deferred targets:

- Linux AppImage.
- RPM.
- Flatpak.
- Snap.
- Signed/notarized macOS stable artifacts.

Broader Linux package types should wait for user demand and a clearer permission story.

## CI Matrix

Each pull request should run source compatibility checks across all target OS families:

- Windows: lint, typecheck, tests, native dependency install check.
- Linux: lint, typecheck, tests.
- macOS: lint, typecheck, tests.

The user will manage exact Blacksmith runner labels. Blacksmith supports Linux, Windows, and macOS runners, but workflow files should not assume labels until the account-specific runner names are known.

Packaging jobs should run on native platform runners:

- Windows package job on Windows runner.
- Linux `.deb` package job on Linux runner.
- macOS package job on macOS runner.

Cross-building should not be treated as the primary packaging strategy for Electron desktop releases.

## Platform-Scoped Gates

Release gating is platform-scoped:

- Windows CI gates Windows packaging.
- Linux CI gates Linux packaging.
- macOS CI gates macOS packaging.

A macOS CI failure must not block a Windows release artifact when Windows CI and packaging passed. A Linux CI failure must not block Windows release either.

Aggregate cross-platform status may be reported separately, but artifact publication is one-to-one by platform.

## GitHub Release Model

GitHub Releases are one-per-version:

- Tag: `vX.Y.Z`.
- Release: one entry for that version.
- Assets: platform artifacts attached as they become available.

If a platform build fails, its artifact can be backfilled into the same release later. The workflow must find or create the release for `v${package.json.version}` and upload the platform artifact to that release. It must not create platform-specific tags such as `v4.3.0-macos`.

Backfilled artifacts must be built from the same release tag/source commit unless the change is purely release infrastructure. If app behavior changes, the package version must advance.

## Public Release Publication

Public release publication is gated by stable platforms, not experimental ones.

Current rule:

- Windows is the stable platform.
- A public release may be published once the Windows artifact succeeds.
- Linux and macOS experimental artifacts may be uploaded to the same release later.

Future rule:

- When Linux or macOS are declared stable, their platform-specific release gates should be promoted.
- Experimental platforms should not block stable platform users.

## Release Note Labels

Release notes should include a platform availability table with explicit statuses:

- `Stable`: supported for normal users.
- `Experimental`: artifact exists, community testing needed.
- `Developer Preview`: artifact exists for technical testers and may require manual OS workarounds.
- `Pending`: expected but not uploaded yet.
- `Unavailable`: no artifact for this version.

Initial labels:

- Windows: Stable.
- Linux `.deb`: Experimental.
- macOS unsigned artifact: Experimental or Developer Preview.

## Out Of Scope

This spec does not include:

- Apple Developer account setup.
- macOS signing and notarization implementation.
- Flatpak/Snap permission modeling.
- Replacing the existing Windows packaging target.
- Release note content for a specific version.

## Testing Requirements

Workflow validation should cover:

- Platform CI jobs run independently.
- Each packaging job depends only on its platform CI.
- Release upload attaches assets to the existing semantic-version release.
- Re-running a failed platform packaging job can backfill the same release.
- Release notes clearly identify missing, pending, experimental, and stable platform artifacts.
