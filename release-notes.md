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
