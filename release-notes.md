# Shuddhalekhan 4.4.0

This minor release hardens dictation end-to-end: it makes every successful transcript recoverable, validates the paste target before injecting, supports configurable paste strategies, and protects clipboard contents during the paste transaction.

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

### Clipboard Transactions
- Replaced the plain-text-only clipboard "sandwich" with a bounded multi-format snapshot that captures and restores plain text, HTML, RTF, PNG image data, and bookmarks where available.
- An originally empty clipboard is now restored with an explicit clear operation instead of being left populated with the transcript.
- Added a native wrapper around Windows `GetClipboardSequenceNumber()` so Shuddhalekhan can detect when another application or the user changes the clipboard after staging the transcript.
- If the clipboard sequence number changes before restoration, Shuddhalekhan leaves the current clipboard untouched and reports a structured `clipboard-conflict` result.
- Clipboard restoration and conflict handling always run through `finally`-style cleanup, even when paste dispatch throws or returns a failure.
- Unsupported or oversized clipboard formats are recorded as skipped diagnostics instead of crashing dictation; a configurable size limit keeps large images from being copied into app memory.
- Clipboard and transcript contents are never written to runtime logs or diagnostics.

---

# Shuddhalekhan 4.3.1

This patch release improves Agent Mode sidecar architecture and run-event routing reliability.

## What's Changed

### Agent Mode Architecture
- Extracted reusable JSONL process management for sidecar workers.
- Made sidecar run IDs explicit and moved active-run filtering to the UI event router.
- Centralized discovered MCP tool merging and default policy injection in the config module.
- Expanded regression coverage for sidecar process, config, and routing behavior.

---

# Shuddhalekhan 4.3.0

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

# Shuddhalekhan 4.2.1

This patch release restores generic OAuth support for protected hosted MCP servers.

## What's Changed

### Agent Mode MCP OAuth
- Added generic MCP-client OAuth for HTTP MCP servers that advertise protected-resource authorization.
- Opens server-provided OAuth URLs in the system browser and stores access tokens per configured MCP server.
- Retries MCP discovery after OAuth completes so protected remote servers can discover tools immediately.
- Keeps Gmail presets removed; OAuth support is generic and server-driven.

---

# Shuddhalekhan 4.2.0

This minor release adds multilingual Whisper controls for dictation and Agent Mode.

## What's Changed

### Multilingual Dictation
- Added Settings → Audio controls for spoken language and transcription mode.
- Sends the selected spoken language to Whisper-compatible endpoints.
- Sends whisper.cpp's explicit `translate=true|false` flag so Transcribe mode is not affected by server-level translation defaults.
- Clarified that Whisper translation mode translates speech to English.

---

# Shuddhalekhan 4.1.1

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

# Shuddhalekhan 4.1.0

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
