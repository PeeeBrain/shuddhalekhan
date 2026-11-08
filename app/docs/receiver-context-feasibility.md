# Original-context delivery findings

The maintainer requires Dictation to keep the original input context. Automatic delivery must stop when that context is lost; returning focus must not revive it. Portal keyboard injection cannot enforce this requirement on Wayland.

The investigation is complete at prototype scope. Its Python/C probes, compositor/toolkit patches, runners, raw results, and native build image/cache were archived outside the repository and removed from the app workspace. No host compositor, toolkit, or desktop settings were replaced.

## Evidence, 2026-11-07

The inspected stock KWin 6.8.2 commit handler does not reject stale serials. GNOME's inspected stock IBus/event path queues commits without a receiver-validated original-field token. These findings concern those paths, not every possible future receiver design.

An isolated rootless GNOME session used these source pins:

- Mutter: `1551013ca3eaf29a5a2b7760f81f7b60e759ed73`.
- GNOME Shell: `7904014f5b1a104c003aa481d1e4d0b9c7fe7f79`.
- GTK: `6a7c96b705155e5b6d00228820f132fe786333bd`.

Native queue/dispatch tests passed, including a regression for two input-method instances sharing the same numeric serial. The real Shell-to-GTK fixture then passed seven cases with each of two builds of the same GTK source pin, 14 assertions in total. The builds differed only in the experimental stale-session GTK change; loaded library paths and distinct binary hashes were verified.

The decisive case held a real Wayland commit batch until local focus changed from entry A to B. The unpatched toolkit inserted the text into B; the patched toolkit rejected it. Normal insertion, duplicate refusal, stale-session refusal, return-to-field refusal, and superseded-token handling also passed. Event barriers controlled delivery rather than timing sleeps.

This demonstrates a final-toolkit-hop race for the tested GNOME/GTK design. Compositor-side validation alone is insufficient. The GTK change also conflicts with existing text-input-v3 wording, so it cannot be shipped as ordinary compatibility support without an agreed or negotiated receiving contract.

## Product boundary

Keep Electron. A shell rewrite does not fix this receiving race. Implement previews and final delivery in the app, but keep strict automatic Wayland delivery unavailable until an appropriate receiver exists. Preserve Last Transcript for an explicit user action. This fallback does not complete #240's GNOME/KDE automatic-insertion requirement.

Ordinary IME compatibility, sensitive fields, caller authorization, widgets sharing one IM context, Firefox, Chromium/Electron, Qt, terminals, XWayland, and KDE receiver behavior remain unverified. An object-addressed app/toolkit integration is another possible research path, but it still has to enforce the original context's lifetime at the final edit.

The subsequent [AT-SPI check](receiver-atspi-feasibility.md) tested that alternative in an isolated KDE session. GTK and Qt accepted edits to an unfocused original object. Object addressing prevents redirection to a different object but cannot enforce cancellation after focus loss. Chromium/Electron, Qt Quick, and terminals also lack the required editable-text coverage. No production receiver was enabled, and the host accessibility setting was left unchanged.
