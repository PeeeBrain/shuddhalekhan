# Changelog

User-visible changes to Shuddhalekhan are tracked here as a human-maintained
project history. Release versions and GitHub release notes are derived from Git
tags and commit history, not from this file. Keep new entries under
**Unreleased** until a human-approved release is created.

## Unreleased

### Transcription Providers
- Added OpenAI and Custom OpenAI-compatible batch transcription providers alongside local whisper.cpp.
- OpenAI Cloud and authenticated custom providers use only local validation; reachability checks are limited to local whisper.cpp and auth=none custom endpoints.
- Model names default to empty and never auto-fill; validation trims input, enforces length bounds, and rejects control characters while accepting punctuation and free-form slugs.
- Custom OpenAI-compatible provider (ID `custom-open-ai-compatible`) includes required free-form model in config, UI, and multipart requests.
- Translation routing uses `/audio/translations` for OpenAI API compatibility; translation support declared where supported.
- Custom header names validated as legal HTTP field-name tokens before use.
- Recording readiness validates endpoint, model, and credential before beginning; missing configuration shows a transcription-failed toast with Open Settings recovery.
- Removed `temperature` parameter from OpenAI-compatible multipart requests.
- Config migration preserves all inactive provider configs; legacy `whisperUrl` updates only the local provider without clobbering cloud settings.

### Credential Vault
- Added Windows DPAPI-backed secure storage for Agent Mode API keys, with saved, replace, and remove controls in Settings.
- Agent Mode now supports securely stored API keys alongside existing environment-variable credentials.

### Settings Redesign
- Reorganized Settings into Dictation, Agent, and System groups, with Transcription as the initial destination.
- Added a darker content canvas, cohesive settings controls, accessible vertical navigation, and restrained status tags across MCP and History.
- Text fields now save on blur while toggles and selections save immediately; successful saves use a brief in-window notification and failures remain inline.
- Increased the default Settings window to 1040x720 while preserving the 820x560 minimum size.

### Recording Controls
- Added an Audio setting to choose between push-to-talk and press-once toggle recording while keeping existing hotkeys unchanged.

### Toolchain Modernization
- Upgraded to Electron 43, electron-builder 26, electron-vite 5, and Vite 7.
- Upgraded Tailwind CSS and `@tailwindcss/vite` to 4.3.2.
- Upgraded `typescript-eslint` to 8.63.0.
- Kept `better-sqlite3` at 12.11.1 for Electron 43 native ABI compatibility; verified audit database creation, writes, queries, and reopening.
- Replaced the deprecated `externalizeDepsPlugin` with the supported `build.externalizeDeps` configuration in `electron.vite.config.ts`.
- Pinned the Node engine and CI/local development environments to Node 22.12.0 or newer, the minimum required by Electron 43, electron-vite 5, and Vite 7.
- Updated `better-sqlite3` to a version compatible with Electron 43's native ABI so the native dependency rebuild succeeds.

### Agent Mode MCP Registry
- Added a per-server HTTP redirect control in Settings. Redirects remain blocked by default and can be enabled only for individual trusted MCP servers that require them.
- Upgraded the Agent runtime to AI SDK 7, MCP client 2, and the OpenAI-compatible provider 3, including the stable streaming and step lifecycle APIs and secure redirect denial for HTTP MCP connections.
- Refactored the MCP server registry behind injectable client, OAuth redirect, and sidecar message ports, making connection lifecycle and hot-reload behavior testable without native subprocesses or network listeners.
- Added production adapters for AI SDK stdio/HTTP clients, OAuth redirect handling, and sidecar stdout protocol events.
- Expanded in-memory regression coverage for connection changes, failures, OAuth retry cleanup, namespaced tools, policy updates, and server-status reporting.

### Clipboard Transactions
- Refactored clipboard injection behind a serialized transaction manager and production adapters, keeping native dependencies outside the testable coordinator.
- Copying the last transcript now waits for any active clipboard transaction to finish before reporting completion.
- Added regression coverage ensuring the original clipboard is restored when native paste dispatch throws.

## v4.5.1

This patch release fixes recording pill regressions introduced during the 4.5.0 UX polish.

## What's Changed

### Recording Pill
- The recording pill now appears on the first hotkey press after app startup.
- Agent Mode push-to-talk now hides the pill when the hotkey is released.
- The elapsed timer now resets to 00:00 for each new recording.

---

## v4.5.0

This minor release brings a comprehensive UX and accessibility polish pass across the recording pill, Settings window, Agent Mode toasts, and tray.

## What's Changed

### Recording Pill
- A mode icon now appears inside the pill — a microphone for Dictation and a robot for Agent Mode — so you can tell which mode is active at a glance, not just by color.
- The pill now smoothly fades and scales in when recording starts and fades out when recording stops.
- An elapsed-time readout (mm:ss) is now visible inside the pill while you record.

### Settings
- The sidebar now shows an icon next to each section name for easier navigation.
- Switching between settings sections now has a subtle fade transition.
- A new first-run setup checklist appears in Settings to guide you through setting up the Whisper endpoint, selecting a microphone, and trying your first dictation. It dismisses once you're done.
- The Whisper endpoint field now validates that you've entered a proper URL and offers a "Test connection" button to check that the server is reachable.
- The save status badge now shows a clear error if a setting fails to save, instead of always claiming success.
- The History section now looks consistent with the rest of the Settings window.

### Agent Mode Toasts
- An animated thinking indicator (three pulsing dots) appears while the agent is processing before the first response text streams in.
- Completed, failed, cancelled, and configuration error toasts can now be dismissed manually and also auto-dismiss after a few seconds so they don't linger.
- Configuration error toasts now include an "Open Settings" button so you can jump straight to fixing the problem.
- The approval countdown timer turns red and pulses in the final 5 seconds to signal urgency.
- Approval toasts now show your server's display name instead of a technical identifier.

### Tray
- A "Check for Updates" action is now available directly from the tray menu, so you don't need to open Settings to check.

### Accessibility
- Recording mode is no longer indicated by color alone — icons ensure the mode is identifiable for colorblind users.
- Agent toast activity is now announced to screen readers via live regions.
- The app now respects the Windows reduced-motion preference: waveform animation, pulsing badges, and spinning icons pause or freeze when reduced motion is enabled.
- The agent run history list in Settings is now fully keyboard-navigable with arrow keys, Home, End, and Enter/Space to select.

### Safety
- Removing an MCP server and disabling Agent Mode while a run is active now ask for confirmation first, so you won't lose configuration or interrupt a run by accident.

---

## v4.4.1

This patch release improves the recording pill waveform so it is easier to see and actually reacts to the microphone.

## What's Changed

### Recording Pill Waveform
- Enlarged the waveform bars and made them fill more of the pill.
- The bars now scale with the live microphone level instead of playing a static left-to-right pulse.
- Added per-bar sine-wave motion for an organic, waveform-like feel.
- Clamped bar height so the waveform stays inside the pill bounds even on loud audio peaks.
- Added a subtle mode-colored glow (cool blue for dictation, warm red for Agent Mode).
- Slightly increased the pill window size to give the larger waveform room to breathe without clipping.

---

## v4.4.0

This minor release protects clipboard contents during automatic paste by capturing a bounded multi-format snapshot before dictation and restoring it afterward.

## What's Changed

### Clipboard Transactions
- Replaced the plain-text-only clipboard "sandwich" with a bounded multi-format snapshot that captures and restores plain text, HTML, RTF, PNG image data, and bookmarks where available.
- An originally empty clipboard is now restored with an explicit clear operation instead of being left populated with the transcript.
- Added a native wrapper around Windows `GetClipboardSequenceNumber()` so Shuddhalekhan can detect when another application or the user changes the clipboard after staging the transcript.
- If the clipboard sequence number changes before restoration, Shuddhalekhan leaves the current clipboard untouched and reports a structured `clipboard-conflict` result.
- A successful paste dispatch that detects a subsequent clipboard conflict now reports the `clipboard-conflict` result, while an earlier paste failure (`error`, `input-blocked`, or `target-changed`) is preserved instead of being overwritten.
- The sequence-number guard now treats `0` as a valid value rather than skipping conflict detection on the first dictation after app start.
- Unsupported or oversized clipboard formats are recorded as skipped diagnostics instead of crashing dictation; a configurable size limit keeps large images from being copied into app memory.
- Clipboard and transcript contents are never written to runtime logs or diagnostics.

---

## v4.3.2

This patch release makes successful dictations recoverable when automatic clipboard paste fails or is blocked.

## What's Changed

### Dictation Recovery
- Every non-empty successful transcription is now kept as an in-memory "last transcript" before any clipboard or synthetic input work begins.
- Text injection now returns a structured result that distinguishes full dispatch, partial/zero-event dispatch, clipboard conflicts, target changes, and unexpected errors.
- Native `SendInput` paste dispatch now reports the number of accepted input events and the relevant Win32 error code when dispatch is incomplete.
- Failed automatic paste shows a passive system notification instead of a modal transcription error, and the transcript remains recoverable from the tray.
- Added tray actions to **Paste Last Transcript** (through the same injection pipeline as normal dictation) and **Copy Last Transcript** (without sending synthetic keyboard input).
- Concurrent injection and retry operations are serialized through a central queue so clipboard staging, paste, and restoration cannot interleave.
- Transcript contents stay in memory only and are never written to logs, diagnostics, or release artifacts.

### Target-Aware Paste & Paste Strategies
- Captures privacy-safe foreground target metadata (window handle, process/thread IDs, window class, executable path, and timestamp) when dictation starts.
- Validates the current foreground target against the captured snapshot before any clipboard modification.
- Same window and same process → paste proceeds.
- Different window in the same process → paste proceeds and a privacy-safe transition diagnostic is logged.
- Different process, missing, or uninspectable target → returns a structured `target-changed` result and leaves the transcript recoverable.
- Shuddhalekhan never forcibly restores focus to the original target.
- Added configurable paste strategies: `ctrl-v`, `shift-insert`, and `ctrl-shift-v`, with per-application overrides keyed by executable file name.

---

## v4.3.1

This patch release improves Agent Mode sidecar architecture and run-event routing reliability.

## What's Changed

### Agent Mode Architecture
- Extracted reusable JSONL process management for sidecar workers.
- Made sidecar run IDs explicit and moved active-run filtering to the UI event router.
- Centralized discovered MCP tool merging and default policy injection in the config module.
- Expanded regression coverage for sidecar process, config, and routing behavior.

---

## v4.3.0

This minor release introduces an Agent Run Inspector & Audit Log Viewer, a Personal Dictionary for dictation, generic MCP OAuth support, multilingual Whisper controls, and agent toast refinements.

## What's Changed

### Agent Run Inspector & Audit Log Viewer
- Added a new **History** tab in Settings with a full audit log viewer for agent runs.
- Browse past agent runs with transcript, status, tool usage, and final response summaries.
- Drill into individual runs to see a detailed execution timeline with expandable JSON payloads.
- Live updates: agent runs update in real-time as execution progresses.
- Audit data is persisted in a local SQLite database via the `better-sqlite3` dependency.

### Dictation
- Added a **Personal Dictionary** to the Settings > Audio tab. Users can add specific names, technical terms, or acronyms to help Whisper spell them correctly.
- Added **multilingual Whisper controls**: spoken language selector and transcription mode (Transcribe / Translate) in Settings > Audio.
- Sends `language` and `translate` flags to Whisper-compatible endpoints.

### Agent Mode
- Removed hardcoded Gmail MCP preset in favor of **generic MCP-client OAuth** for HTTP MCP servers.
- MCP servers that advertise protected-resource authorization now open OAuth URLs in the system browser.
- Access tokens are stored per configured MCP server and retried after OAuth completes.
- Agent toast approval buttons now show loading states with instant feedback on approve/deny.
- Added a **Dismiss** button to completed agent toasts.
- Recording pill visual polish: smaller, tighter bars for a cleaner look.
- Agent status events, completions, failures, and cancellations now push live updates to the audit log.

### CI
- Release workflow now depends on CI success via `workflow_run`.

---

## v4.2.1

This patch release restores generic OAuth support for protected hosted MCP servers.

## What's Changed

### Agent Mode MCP OAuth
- Added generic MCP-client OAuth for HTTP MCP servers that advertise protected-resource authorization.
- Opens server-provided OAuth URLs in the system browser and stores access tokens per configured MCP server.
- Retries MCP discovery after OAuth completes so protected remote servers can discover tools immediately.
- Keeps Gmail presets removed; OAuth support is generic and server-driven.

---

## v4.2.0

This minor release adds multilingual Whisper controls for dictation and Agent Mode.

## What's Changed

### Multilingual Dictation
- Added Settings → Audio controls for spoken language and transcription mode.
- Sends the selected spoken language to Whisper-compatible endpoints.
- Sends whisper.cpp's explicit `translate=true|false` flag so Transcribe mode is not affected by server-level translation defaults.
- Clarified that Whisper translation mode translates speech to English.

---

## v4.1.1

This patch release focuses on internal architecture cleanup for the Electron main process, MCP configuration, and Settings UI. User-facing behavior is intended to remain unchanged.

## What's Changed

### Architecture Cleanup
- Centralized the recording lifecycle behind a `RecordingSession` module.
- Added shared window lifecycle, sidecar event routing, sidecar config restart policy, MCP config normalization, and text injection modules.
- Split MCP settings UI and settings IPC access into dedicated renderer modules.
- Expanded regression coverage for the new module seams.

## Update Note

No breaking changes. This release preserves existing configuration and workflows while improving maintainability and test coverage.

---

## v4.1.0

This release delivers a comprehensive UI/UX polish pass with a new cohesive color theme, cleaner settings window, and native-feeling agent toasts.

## What's Changed

### New Theme: Arctic Steel
- Replaced the jarring slate-grey + yellow + red palette with a cool, cohesive **Arctic Steel** theme.
- New primary color is a soft cyan (`hsl(195 65% 65%)`) — calm and distinctive.
- Destructive/agent states now use muted coral (`hsl(355 55% 60%)`) instead of harsh bright red.
- Success states use soft teal (`hsl(165 45% 55%)`).
- Warning states are warm amber (`hsl(35 70% 60%)`), clearly distinct from primary.
- Background shifted to deep blue-black (`hsl(215 16% 7%)`) for a refined, native dark feel.

### Settings Window Redesign
- Adopted a **floating panel / sheet** style inspired by Apple System Settings and Windows 11.
- Sidebar and content area now share the same background with a single subtle 1px separator.
- Eliminated all hardcoded hex colors (`#101214`, `#181b1e`, etc.) in favor of Tailwind theme tokens.
- Replaced arbitrary Tailwind values with standard tokens for consistency and scalability.
- Navigation simplified to minimal text-only rows with hover/active states.
- Layout standardized: flex rows for toggles, stacked label-above-input for text fields.
- MCP server cards and tool policy editor cleaned up.
- Shortcut display redesigned as **individual keycaps** with 3D gradient styling.
- Windows key now shows the **official Windows logo icon** instead of plain text.

### Agent Toast Redesign
- Removed CSS grid pattern overlays and all gradient backgrounds.
- Adopted a minimal, native-feeling **card aesthetic**: `bg-card`, `border-border`, subtle shadow.
- State communicated via a **small left accent border** color-coded by state:
  - Blue for agent thinking / streaming
  - Amber (thicker border + stronger shadow) for approval
  - Red for failure / cancelled
  - Green for completed
- Typography standardized to theme tokens.

### Architecture Cleanup
- Removed the hidden `MainWindow` that was never shown. The tray menu and settings window are now the only persistent user-facing surfaces.
- Added `@svgl` registry support for high-quality SVG icon components.

## Update Note

No breaking changes. All existing configuration and behavior remain identical — only visual presentation has changed.
