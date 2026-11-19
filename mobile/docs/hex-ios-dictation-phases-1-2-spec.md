# Specification: iOS dictation polish and native system integration (Phases 1–2)

**Status:** Proposed / implementation planning requested  
**Date:** 2026-11-19  
**Target:** Shuddhalekhan iOS (`mobile/`), currently Expo SDK 58 + React Native, deployment target iOS 17.0  
**Shuddhalekhan baseline:** [`7e0f7258ac33fb536af294f3d6fb7b4698cf89e7`](https://github.com/PeeeBrain/shuddhalekhan/commit/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7) (`main` at review)  
**Hex research baseline:** [`8bc6e45a6b28686e28cbb2ab3dbcee1849610c62`](https://github.com/anomalyco/hex/commit/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62) (`dev` at review)  
**Scope:** Phase 1 = dictation ergonomics and setup; Phase 2 = system activation, Live Activity controls, clipboard handoff, optional on-device cleanup. **Phase 3 (full QWERTY keyboard) is expressly excluded.**

> This is a requirements specification, not a claim that Hex's iOS behavior has passed physical-device validation. Hex documents its iOS app as an internal TestFlight build and lists hardware-only proof gaps. Codex must inspect the current code, identify conflicts, and produce an implementation plan before editing production paths. Links to source code are pinned to reviewed commits; inspect newer commits before porting concepts.

## 1. Objective and non-negotiables

Make Shuddhalekhan feel like an iOS-native dictation utility, with fewer taps between thought and inserted text, without sacrificing its on-device/offline privacy, voice Agent Mode, MCP authorization, or existing session correctness.

1. **No paid infrastructure or additional hosted transcription/LLM service.** Reuse on-device FluidAudio/Parakeet, the user's existing opt-in provider settings, and Apple's on-device frameworks where supported. The OS/device may impose platform requirements; no paid SDK/API is introduced.
2. **Do not replace or fork the existing background keyboard transport.** Shuddhalekhan currently uses authenticated loopback TCP for commands/results, a named pasteboard only for foreground session discovery, and native background microphone ownership. Do not replace that with Hex's App Group polling just for feature parity.
3. **Native ownership of background operations.** Swift must own any microphone session, speech inference, state progression, cancellation, and system-intent behavior that must survive React Native suspension. No JS timer/network promise may be assumed to execute when the phone is locked.
4. **Dictation and Agent Mode remain separate.** Dictation formatting must never rewrite an agent command by default; copied dictation must never accidentally be dispatched to MCP tools. Existing tool approvals cannot be bypassed by system shortcuts.
5. **No private or extension-unavailable APIs.** Do not port Hex's Objective-C `UIApplication` responder-chain keyboard opener. Do not promise app auto-return or cross-app text-field access in this scope.
6. **Keep existing installations stable.** Existing default behavior/settings and transcript insertion remain compatible. Feature flags and staged migration are required where behavior changes. No silent new network calls, model downloads, or recording.
7. **Privacy and performance first.** No raw audio/transcript/credentials in logs; bounded state, no duplicate insertion, no ambient always-on speech processing, no extra permanent animation/polling cost. Accessibility and reduced motion are mandatory.

### Current state, verified in repo

| Area | Current Shuddhalekhan behavior | Design implication |
| --- | --- | --- |
| Keyboard | Custom voice/agent keyboard; does not provide letter keys | Preserve voice-focused keyboard in Phases 1–2; full keyboard is out of scope |
| Keyboard sessions | UI uses fixed 10 minutes, native host validates 1–30 minutes | Add safe 5/10/15/30-min choices with 10-minute default |
| Microphone and inference | Native `KeyboardSessionHost` + `ParakeetEngine`; FluidAudio/Core ML | Extend rather than create a competing keyboard speech stack |
| In-app transcription | React Native controller + local and configured remote providers | Make styles available for in-app dictation too; do not change STT providers |
| Settings | Static keyboard setup guidance, not a consolidated live readiness checklist | Add live states with explicit “unknown” where iOS hides information |
| Live Activities | Existing `agent-activity` widget and `AgentActivityManager` for agent/session status | Extend or reuse widget *infrastructure*, not agent authorization semantics |
| System actions | No app-intent/control-widget action found in reviewed iOS implementation | Add native system entry points with iOS-version gating |
| Distribution | Unsigned Release IPA, signed on device; native changes require new IPA | Test app/keyboard/widget entitlements and sideloaded build identifiers on physical phones |

Relevant Shuddhalekhan code: [mobile README](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/README.md), [keyboard controller](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/targets/transcript-keyboard/KeyboardViewController.swift), [session host](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/modules/shuddhalekhan-speech/ios/KeyboardSessionHost.swift), [session protocol](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/modules/shuddhalekhan-speech/ios/KeyboardSessionProtocol.swift), [session hook](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/src/useKeyboardSession.ts), [speech module](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/modules/shuddhalekhan-speech/ios/ShuddhalekhanSpeechModule.swift), [app configuration](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/app.json), [agent widget](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/targets/agent-activity/AgentLiveActivity.swift).

## 2. Phase 1 requirements — frictionless dictation

### P1.1 — Selectable dictation styles

**User story:** As a user dictating into Notes, messages, or email, I can select a predictable output style without paying for an LLM.

**Functional requirements**
- Expose four styles with descriptions in iOS Settings: **Polished** (light filler cleanup, sentence capitalization, punctuation), **Casual** (conversational casing, avoid forced final period), **Notes** (spoken “new line”, “new paragraph”, “bullet” conventions), and **Verbatim** (minimum transformations; preserve recognizer wording).
- Show the selected style in the voice keyboard and provide a lightweight picker/change action while **idle**; selection persists. Avoid reflowing an active recording or inventing a full typing keyboard.
- Preserve existing users' current transcript behavior on upgrade unless they actively select a style. Implement an explicit legacy-migration rule; for new installations, select an intentional and documented default. Do not use `Polished` to retroactively change saved results.
- Apply the selected style once per **Dictation** utterance, including in-app transcription, local keyboard transcription, and in-app remote-provider results. Do not style Agent Mode requests unless an independently specified opt-in is introduced later.
- Style is snapshotted at request acceptance: switching UI midway cannot change or reapply the formatting of a result already in flight. Handle language-specific punctuation conservatively; do not silently translate non-English text or force English casing rules on unsupported scripts.
- Choose a single testable formatter ownership scheme. Preferred: one pure Swift formatter shared by the native host and exposed through the Expo module to the in-app JS/controller; the keyboard's context-aware insertion remains inside `UIInputViewController`. If a TS mirror is unavoidable, share conformance fixtures and prove parity.

**Acceptance criteria**
- Each style produces deterministic results on a fixed test corpus (filler words, casing, punctuation, bullets, explicit line breaks, quotes, contractions, empty text, Unicode, and non-English input).
- All three dictation entry paths use the same semantics; agent input remains unchanged.
- A single request produces exactly one formatted transcript, never a double-format pass or duplicate insertion.
- Offline mode succeeds with local Parakeet; no new endpoint or subscription is required.

**Research:** Hex [`DictationStyle` / `TranscriptFormatter`](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXShared/TranscriptFormatter.swift), [keyboard style selection](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXKeyboard/KeyboardViewController.swift), [formatter tests](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobileTests/KeyboardBridgeTests.swift).

### P1.2 — Custom vocabulary / preferred spellings

**User story:** Acronyms, names, technical jargon, and project terms keep my preferred spelling even if STT recognizes a near match.

**Functional requirements**
- Opt-in, editable local vocabulary under iOS Transcription settings. Support add/edit/remove, search or filter, and a clear disabled state. Cap at **100 distinct entries**, each at most **64 characters**; reject blank/degenerate entries and duplicate normalized keys.
- Deterministically rewrite high-confidence lexical matches across case, spaces, a single hyphen, and appropriate possessives; preserve the user-entered canonical spelling (e.g., `PyTorch`, `Shuddhalekhan`) and never replace arbitrary substrings inside unrelated words.
- Snapshot vocabulary at utterance start. Do not download models, share the list with cloud providers, or silently use an LLM. Explicitly distinguish post-STT correction from recognition-time bias; current FluidAudio Parakeet batch mode has no demonstrated vocabulary-hint API.
- Proposed stage order: **raw STT → vocabulary normalization → (Phase 2 optional guarded cleanup) → selected style → final vocabulary spelling restoration → cursor-aware insertion/copy**. Tests must ensure each pass is idempotent and terms aren't overwritten by capitalization.
- Store the vocabulary in current mobile settings/native-app-private persistence; ensure native background sessions can access a validated snapshot without depending on suspended JS. Protect against corrupted/oversized persisted values. No logging user vocabulary contents.

**Acceptance criteria**
- Terms with whitespace, hyphens, apostrophes, mixed casing, repeated words, and punctuation get correct/unchanged output on a documented corpus.
- Disabling vocabulary returns to current STT output; Agent Mode is unaffected.
- No unbounded regex work or catastrophic backtracking on long dictations.

**Research:** Hex [`CustomVocabularySettings`](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXShared/CustomVocabularySettings.swift), [`VocabularySpelling`](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXShared/VocabularySpelling.swift), [custom vocabulary UI](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobile/CustomVocabularyEditor.swift), [tests](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobileTests/CustomVocabularyTests.swift).

### P1.3 — Context-sensitive insertion, safe Undo, and small editing affordances

**User story:** Dictation at a cursor joins existing text naturally and I can undo an erroneous insertion quickly.

**Functional requirements**
- At the **final keyboard insertion boundary**, use `textDocumentProxy.documentContextBeforeInput` / `documentContextAfterInput` where supplied to decide if surrounding whitespace is needed. No spaces before closing punctuation; avoid spaces just after an opening bracket/quote, double spaces, duplicate newlines, or unwanted spaces around emoji and apostrophes.
- Context can be `nil`, truncated, or unavailable for secure input fields. Default to the least destructive insertion behavior; never assume access to the focused app's full document or selected text.
- Add a transient **Undo Dictation** action after successful keyboard insertion only. Retain the exact inserted text and result ID locally for a short bounded period (suggest ~10–12 seconds). Offer Undo only while the keyboard/context is still credible; verify the visible preceding suffix matches the inserted text before deleting; suppress if verification is impossible, another edit is detected, the keyboard disappears, the field changes, or another insertion succeeds.
- Delete Unicode characters/grapheme clusters correctly. Never undo by blasting a fixed number of backspaces into an unknown field; user edits always win.
- Keep the existing keyboard's repeat-backspace, globe key, Dictate, Ask Agent, Stop, Cancel, and animations operational. No full keyboard in this scope.

**Acceptance criteria**
- One-and-only-one insertion per request ID persists across reconnects, expiry, cancellation, and delayed results.
- Cursor-before/after punctuation and Unicode fixture tests pass; Undo cannot delete adjacent user text or agent output.
- Tests cover empty context, protected fields, keyboard replacement, rapid consecutive sessions, and editing between insertion and Undo.

**Research:** Hex [insertion whitespace algorithm](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXShared/TranscriptFormatter.swift), [insertion from keyboard](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXKeyboard/KeyboardViewController.swift), [undo UI in experimental keyboard](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXShared/FullKeyboard/FullKeyboardView.swift). Shuddhalekhan [`KeyboardSession.insertion` ID contract](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/modules/shuddhalekhan-speech/ios/KeyboardSessionProtocol.swift), [current keyboard code](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/targets/transcript-keyboard/KeyboardViewController.swift).

### P1.4 — Configurable warm keyboard-session duration

**User story:** I can choose an appropriate microphone session length while seeing that my mic remains open.

**Functional requirements**
- Expose presets **5, 10, 15, 30 minutes** (default **10 minutes**, preserving existing installs). Persist the selected preset; pass it through the native `startKeyboardSession(minutes:...)` contract.
- Preserve the semantics of the existing foreground user-initiated microphone session. It must not start automatically on launch; session start/stop requires an intentional action, and the running state remains visible with countdown and Stop.
- Handle interrupted/expired sessions without dropping an accepted in-flight utterance, prematurely deleting its recording, or leaving microphone ownership active. Preserve existing agent admission/approval behavior.
- Respect actual iOS limits and device battery/audio behavior. Shuddhalekhan currently pauses music during a warm session; do **not** silently change session audio category/routing during this feature.
- Any failure to sustain 30 minutes in the background must be surfaced, not disguised as successful completion. Do not add Hex's 60-minute mode without separate device and thermal testing.

**Acceptance criteria**
- Each preset results in correct deadline and UI countdown; changing default only affects the **next** session.
- Early Stop, call/Siri interruption, app kill, recording during expiry, and language/model changes leave clean states.
- Original foreground recording, keyboard dictation and keyboard Agent Mode still operate after changing durations.

**Research:** Hex [`WarmSessionDuration` enum and expiry contracts](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXShared/KeyboardBridge.swift), [`DictationController` session handling](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobile/DictationController.swift); current [10-minute JS constant](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/src/useKeyboardSession.ts), [native 1–30-minute validation](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/modules/shuddhalekhan-speech/ios/KeyboardSessionHost.swift).

### P1.5 — Live keyboard-readiness onboarding and clear failures

**User story:** On first install, I know *exactly* why dictation from another app is not ready.

**Functional requirements**
- Replace/augment static keyboard instructions with a live checklist: (1) custom keyboard added, (2) Full Access confirmed, (3) microphone permission, (4) selected on-device model installed/prepared, (5) optional agent credentials if Ask Agent is enabled.
- Provide correct iOS Settings links and concise explanations of Full Access. Show **Unknown / Not verified** rather than green when the OS cannot reveal status; stale keyboard handshakes never count as current Full Access verification.
- Request microphone permission only from an explicit user action. Model preparation and download states must be specific and retryable; downloads remain opt-in.
- Offer a **Test dictation** guided path and contextual troubleshooting for no model, no microphone, no keyboard handshake, and expired session. Preserve the current fallback for keyboard taps when no session is running.
- Do not misreport a settings URL as a direct link to a protected iOS subpage; use documented APIs/fallback instructions.

**Acceptance criteria**
- A fresh installation and an upgraded installation get accurate, recoverable states, including denied permissions, missing keyboard, disabled Full Access, not-ready model, and agent-disabled mode.
- Setup screens work with Dynamic Type, VoiceOver, Reduce Motion, and display rotations.
- No persistent timer/polling loop runs while the setup screen is closed.

**Research:** Hex [`KeyboardSetupMonitor` and card](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobile/KeyboardSetup.swift), [keyboard fallback UI](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXKeyboard/KeyboardViewController.swift); Shuddhalekhan [existing Settings page](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/src/ui/SettingsScreen.tsx), [model state](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/src/on-device.ts).

### P1.6 — Phase 1 cross-surface consistency and regression protection

- Existing Start/Stop/Error recording tones and visual mic/agent distinctions are **already implemented**; preserve them rather than rebuilding them.
- Transcript formatting, dictionary application, and insertion must never suppress the existing error/timeout/cancel acknowledgment.
- Consider an explicit temporary UX notice when formatting was applied, but do not add auto-rewriting of already inserted text.
- Write native self-checks and TS tests for all added behavior; update `mobile/README.md` with product semantics and verified limits.
- New settings must survive restarts and OTA JS changes, but any native behavior requires a new IPA.

**Phase 1 exit gate:** Styles, vocabulary, insertion, Undo, duration choice, and readiness UI are demonstrably correct and offline-capable on a physical iPhone; native contract tests pass. Publish performance baseline and regressions; do not proceed to Phase 2 with an unstable recording state machine.

## 3. Phase 2 requirements — native system integration

### P2.1 — Native App Intents and Shortcuts entry points

**User story:** I can start/stop dictation or prepare the Shuddhalekhan keyboard with the Action Button, Back Tap, Siri, Shortcuts, or Spotlight rather than navigating through the app.

**Required actions**
- **Dictate with Shuddhalekhan:** A user-initiated one-shot local dictation toggle/start action; second invocation or explicit Finish stops, performs on-device transcription, and copies (or safely offers) the result. Clearly show Recording → Transcribing → Copied/Failed.
- **Start Shuddhalekhan keyboard session:** Explicitly prepare the app's existing bounded keyboard microphone session using the selected preset. Repeated invocation must not start duplicate sessions or silently extend one; provide Stop Session.
- **Ask Shuddhalekhan (optional behind a separate setting):** Initiate voice capture for a one-off agent request, following the existing configured provider and permission pipeline. It must **never** cause an unauthorized tool execution, and must not run when agent configuration is missing.

**Requirements**
- Define native `AppIntent` / `AppShortcutsProvider` actions with descriptive titles, spoken phrases, and discoverability; conform to Apple `AudioRecordingIntent` + `LiveActivityIntent` when an intent starts system-level audio recording, as supported by the installed SDK/OS. **Apple requires an active Live Activity for recording started with `AudioRecordingIntent`.**
- Separate start, stop, and cancel (even if one button toggles based on state); double taps, races, repeated shortcut invocations, and stale commands must be idempotent.
- If permission, configured local model, background execution, or Live Activity capability is unavailable, fail visibly or require a foreground route; do not claim background recording succeeded. Dictation-only system actions must not depend on an agent/cloud provider.
- Background-capable logic belongs in a native coordinator independent of React Native view lifecycle. For a standalone intent, do not assume the keyboard's loopback server is present, or that `expo-audio` can record after JS suspension.
- Gate features by iOS availability, especially `supportedModes` in iOS 26. Maintain baseline iOS 17 functionality when the system entry point is unavailable.

**Acceptance criteria**
- Actions appear and work in Shortcuts/Siri when authorized; physical Action Button and Back Tap can invoke the eligible shortcut via OS configuration.
- Start while app is backgrounded/locked is proven on hardware where supported; unavailable cases return a truthful, actionable reason.
- Rapid/overlapping intents do not create multiple audio sessions or duplicate results; cancellation releases all owned resources.

**Research:** Hex [`HexIntents.swift`](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobile/HexIntents.swift), [`HexSystemCommandBus` + stop/cancel intents](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXActivity/HexActivityAttributes.swift), [native `DictationController`](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobile/DictationController.swift). Apple [App Intents](https://developer.apple.com/documentation/appintents), [AudioRecordingIntent](https://developer.apple.com/documentation/AppIntents/AudioRecordingIntent), [LiveActivityIntent](https://developer.apple.com/documentation/AppIntents/LiveActivityIntent), [App Shortcuts](https://developer.apple.com/design/human-interface-guidelines/app-shortcuts).

### P2.2 — Control Center / Lock Screen controls

**User story:** Starting or ending dictation is available from iOS system controls without opening the keyboard.

**Functional requirements**
- Add a `ControlWidget` exposing Dictate (state-aware) on **iOS 18+**, with a fast route to stop/cancel. Support Lock Screen/Control Center placements as provided by the OS. State must come from the same native coordinator as App Intents, never a separate boolean.
- Prefer adding the control to the **existing agent-activity WidgetBundle** if build targets and entitlements permit; do not add a redundant extension unless technically necessary. Maintain the existing agent status widget.
- Ensure no control action silently authorizes a tool, initiates networked Agent Mode, or bypasses the explicit mic permission.
- Control appearance and intent availability reflect disabled model, recording, processing, and error states; do not offer a misleading “recording” state after failed startup.

**Acceptance criteria**
- Control works from Control Center on physical iOS 18+ devices and does not break Live Activities on iOS 17.
- State is consistent across app, Shortcuts, system control, and keyboard session; no duplicated recording.
- Signing/build and extension registration are verified on the sideloaded release path.

**Research:** Hex [`HexDictationControl.swift`](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXWidgets/HexDictationControl.swift), [`HexControlIntents.swift`](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXActivity/HexControlIntents.swift), [widget bundle](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXWidgets/HEXWidgetsBundle.swift); Shuddhalekhan [existing widget bundle](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/targets/agent-activity/AgentLiveActivity.swift). Apple [ControlWidget](https://developer.apple.com/documentation/swiftui/controlwidget), [Control Center controls](https://developer.apple.com/documentation/widgetkit/creating-controls-to-perform-actions-across-the-system).

### P2.3 — Recording Live Activity and audio-session arbitration

**User story:** I can always see that recording is ongoing and stop it from the system surface.

**Functional requirements**
- Represent standalone system dictation with a recording/transcribing/completed/failed Live Activity, exposing **Stop** and **Cancel** controls where the OS allows. Avoid showing sensitive transcript text on the Lock Screen by default. Do not conflate this activity with Agent Mode's tool-approval UI.
- Centralize microphone ownership and serialize mutually exclusive jobs: in-app Dictation, keyboard warm session, one-shot system Dictation, and agent voice capture. Define explicit transfer/rejection rules; never let an intent steal the mic invisibly.
- Maintain unique monotonically ordered job generations/request IDs, cancellation tokens, temporary file ownership, and cleanup. A delayed STT result cannot overwrite a newer request or cause another app's text insertion.
- Follow Apple's recording-Live-Activity requirements. Respect the user's Live Activity and notification settings; if background continuation is impossible, explain that the app must be opened rather than attempting indefinite work.
- Handle phone/FaceTime/Siri interruptions, route changes, model preparation delays, app backgrounding, force quit, and session expiry. Preserve Shuddhalekhan's current native audio cleanup and existing agent activity lifecycle.

**Acceptance criteria**
- At most one active recording owner and one final result per request, even across repeated action presses and app foreground changes.
- Every path has Stop, Cancel, expiry, and failure observability; microphone is released after terminal state.
- System and app surfaces remain consistent after a phone call and after reboot/relaunch.

**Research:** Hex [`DictationController` race handling](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobile/DictationController.swift), [`LiveActivityCoordinator`](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobile/LiveActivityCoordinator.swift), [`HexActivityAttributes`](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXActivity/HexActivityAttributes.swift), [controller tests](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobileTests/DictationControllerTests.swift); Shuddhalekhan [native session host](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/modules/shuddhalekhan-speech/ios/KeyboardSessionHost.swift), [agent Live Activity manager](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/modules/shuddhalekhan-agent-activity/ios/AgentActivityManager.swift).

### P2.4 — Explicit clipboard handoff for system dictation

**Functional requirements**
- An explicitly invoked standalone Dictation intent may **copy completed text**, with visible “Copied” confirmation; it cannot insert into the text field of another app or promise to reopen the last app. Any text insertion into third-party apps continues through the custom keyboard.
- Copy only a successfully finished, non-empty, non-cancelled Dictation result. No clipboard write for agent commands; never place credentials, tool arguments, or agent responses on the clipboard accidentally.
- Prefer a privacy-conscious `UIPasteboard` write (local-only/expiring when appropriate) and be clear that iOS clipboard contents can be read by other apps with OS-mediated permissions. Verify locked/background pasteboard writes on real hardware; if OS disallows delivery, retain a safe result in-app with an explicit Copy action rather than falsely claiming success.
- “Copied” is not “Pasted”; no cursor injection, accessibility automation, or fabricated app switching.

**Acceptance criteria**
- Result can be pasted by the user into Notes/Messages after system dictation; cancellation/failure never changes existing clipboard.
- Duplicate completion callbacks cannot recopy stale text or leak the prior request's result.

**Research:** Hex [intent completion contract](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobile/HexIntents.swift), [copy flags in controller](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobile/DictationController.swift).

### P2.5 — Optional on-device Apple Intelligence cleanup (iOS 26+)

**User story:** On supported iPhones, I can correct obvious ASR misrecognitions or self-corrections locally without sending text to an external LLM.

**Functional requirements**
- Add opt-in **Clean up with Apple Intelligence** under Transcription (off by default). Only show it as actionable when `FoundationModels` / `SystemLanguageModel.default.availability` reports available; otherwise display the precise reason (OS too old, unsupported hardware, disabled, model not ready, language unsupported).
- One conservative, on-device pass for **Dictation** only, not Agent Mode by default. No fallback network call or provider billing; never block transcription indefinitely waiting for this pass.
- Use a firm timeout budget (Hex uses **2 seconds**, to be validated for our iPhone), a single in-flight cleanup per utterance, and cancellation/generation guards. Timeout, empty output, model failure, and unsupported language must return the original normalized transcript.
- Protect semantic integrity: preserve numbers, negations, named entities, and user vocabulary; reject large/unrelated rewrites. An LLM is inherently fallible—do not promise perfect meaning preservation. Keep raw output available for debugging **in memory** without logging it, and allow users to turn cleanup off immediately.
- Respect pipeline ordering from P1.2, reassert canonical vocabulary after formatting, and record **non-sensitive** stage timings/outcomes.
- Verify both model availability and supported locales at runtime; do not assume all phones on iOS 26 support Apple Intelligence.

**Acceptance criteria**
- Compatible device: successful local cleanup of a recorded phrase with no outbound request; changed digits/negations and implausible rewrites fall back safely.
- Unsupported device/OS: dictation continues with no extra latency from attempted cleanup.
- Cancellation or a newer dictation request prevents stale cleanup from modifying clipboard, insertion, or a later result.

**Research:** Hex [`TranscriptCleanup.swift`, guards and FoundationModels integration](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobile/TranscriptCleanup.swift), [guard tests](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobileTests/TranscriptCleanupTests.swift), [cleanup settings](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXShared/AppleIntelligenceCleanupSettings.swift); Apple [Foundation Models](https://developer.apple.com/documentation/FoundationModels/), [availability and use](https://developer.apple.com/documentation/FoundationModels/generating-content-and-performing-tasks-with-foundation-models), [locale support](https://developer.apple.com/documentation/foundationmodels/supporting-languages-and-locales-with-foundation-models).

### P2.6 — Compatibility, permissions, and no hidden auto-return

- Keep iOS **17** deployment target unless Codex establishes a compelling and approved reason to change it. Use availability guards: Control Widgets iOS 18+, Apple Intelligence iOS 26+, Action Button only on supported hardware; Back Tap/Shortcuts behavior is user configured.
- The custom keyboard cannot itself own microphone capture. The system-intent native coordinator must not bypass foreground activation restrictions or rely on the keyboard extension to be alive.
- **Explicitly out of scope:** Hex's responder-chain `UIApplication.open(_:options:completionHandler:)` called through Objective-C from `UIInputViewController`, its host app URL-scheme “auto-return,” automatic discovery of another app's bundle ID or focused field, and full QWERTY keyboard. Those are separate Phase 3 research items; no private APIs or undocumented extension escapes in this project.
- Give truthful UI instructions on enabling an Action Button/Back Tap shortcut instead of attempting to programmatically change system settings.

**Research and policy warning:** Hex's [`ContainingAppOpener.swift`](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXKeyboard/ContainingAppOpener.swift) deliberately calls extension-unavailable UIKit methods. Apple's [Extension Overview](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionOverview.html) and [App Review Guidelines §2.5.1](https://developer.apple.com/app-store/review/guidelines/) prohibit private/unavailable API usage. **Do not port that technique.**

**Phase 2 exit gate:** Physical-device proof for system activation, Live Activity, controls, clipboard handoff, and fallback states, with no regression to keyboard dictation or native agent approvals. The spec is not satisfied by a green simulator build alone.

## 4. Architecture and integration guidance (not a mandated design)

**Suggested boundaries (Codex should validate before implementing):**
1. **Pure transformation layer** — style formatting, vocabulary matching, cleanup guard; deterministic, independently tested. Reuse it for local and remote in-app dictation via an Expo bridge, and for keyboard sessions through the native containing app. Keep cursor-aware spacing/Undo at the extension's insertion boundary.
2. **Native speech/recording coordinator** — a single arbitrator for microphone ownership, jobs, cancellation, file cleanup, and local model inference. Integrate with `KeyboardSessionHost` and `ParakeetEngine`; avoid rewriting them. System intents must not require a mounted React Native screen.
3. **Bounded session protocol** — extend `KeyboardSessionProtocol` / `KeyboardSessionChannel` only if new style metadata is necessary; include strict schema validation, stale-command rejection, result IDs, and backward-safe changes. Keep secrets out of logs and result payloads.
4. **Settings and onboarding** — React Native settings persist selected style, duration, custom vocabulary, and cleanup opt-in, then publish validated native snapshots as required. A warm session captures immutable per-request configuration. Do not add a separate unsynchronized settings database without justification.
5. **App Intents and widgets** — use Swift `AppIntents`, `ActivityKit` and WidgetKit, integrate with the existing `agent-activity` target/plugin where feasible. Make the new recording activity distinct from agent progress/approval. Review target inclusion under `mobile/plugins/with-shared-native-contracts.js` and `@bacons/apple-targets`.
6. **Distribution** — regenerate an IPA whenever adding Swift, intents, entitlements or extensions; JS OTA cannot deliver those changes. Verify rewritten bundle IDs, signed extensions, shared entitlements and permissions under the project's iLoader/Sideloadly flow.

**Required decision record before code:** Who owns style/correction logic across native keyboard and JS remote-STT; how settings cross the extension boundary; the arbitration policy among recording modes; the supported background recording lifecycle of each system intent; and which widget target needs modification. Document rejected alternatives with reasons and complexity/performance trade-offs.

## 5. Verification plan

### Automated tests (must land with implementation)
- Table-driven formatter tests for all styles, punctuation, multi-paragraph, empty, CJK/European scripts where appropriate, and Unicode grapheme clusters.
- Vocabulary normalization tests, idempotence, limits, overlapping/compound terms, exact preferred casing, and unusual punctuation.
- Safe insert/Undo tests with before/after context, no-context and secure-field fallbacks, out-of-order IDs, stale states, cancelled results, and a changing target field.
- Native microphone/session tests: durations, expiry during recording/transcription, cancellations while model loads, new job versus stale result, audio interruption, no double-ownership.
- Native App Intents/Control Widget compilation, discoverability/configuration fixtures, coordinator action transitions, Live Activity completion, clipboard only on valid dictation, denied microphone/model not-ready.
- Cleanup guard tests: different numbers, negations, excessive length/word drift, unsupported locale, timeout, cancellation, and offline/availability fallback.
- Existing Agent Mode approval, result notification, recording cues, and keyboard insertion tests remain green.

### Physical-device acceptance matrix
Test at least one iOS 17 device/build path and one iOS 18+ / 26+ capable device when available; mark unsupported hardware **not tested**, not passed. Include a phone with and without an Action Button where practical. On a real signed IPA:
- First install, Full Access off/on, denied mic, model missing/preparing, cold/warm launch, airplane mode, device lock/unlock.
- Dictation in Notes and at least one messaging app; consecutive utterances, cursor edits, emoji, backspace, Undo, quick keyboard switches, expiry and errors.
- Action Button, Shortcuts/Siri, Control Center, Live Activity Stop/Cancel, back-to-back system invocations, background/lock behavior, clipboard copy/paste.
- Incoming phone/FaceTime call, Siri interruption, Bluetooth device route changes, speaker/quiet-mode recording cues, and interrupted app process.
- Agent Mode with approvals enabled, including “Ask Agent” unavailable, disabled tools, and denied tool approvals; verify no action bypasses policy.
- Apple Intelligence available/unavailable and on/off, its locale gates, offline behavior, timeout fallback and cancellation.
- iLoader/sideloaded app group/widget entitlement checks and all target bundle IDs.

### Performance, reliability, and accessibility
- Capture baseline and post-change **tap → listening**, **stop → insertion** (keyboard), **stop → clipboard result** (system), first-launch model readiness, and cancellation-to-mic-release.
- Record device, iOS build, IPA/build number, chosen model, language, and whether the process/model was cold/warm. Use multiple trials and report p50/p95; distinguish recognizer latency from formatter/cleanup latency. Flag material regression rather than claiming success from a single fast run.
- Observe memory and battery/thermal behavior for 5/10/15/30-minute background sessions. Ensure settled UI consumes negligible CPU/GPU; honor Reduce Motion, VoiceOver, Dynamic Type, and touch targets.
- Verify temporary WAV deletion and absence of audio/transcript/secret logs. Do not upload captured audio to analytics.
- Update `mobile/README.md` with **verified** device results, limits, model assumptions, and manual test instructions. CI validates compilation, but does not prove background iPhone survival.

## 6. Implementation sequence and deliverables for Codex

1. **Research + plan PR / issue**: audit current code against this spec, verify Apple's current API availability, inspect the pinned Hex source and upstream changes, propose the smallest architecture with explicit risks and test plan. Identify any requirement blocked by iOS/sideload signing, and propose a supported fallback before implementation.
2. **Phase 1A**: formatter + vocabulary pure logic, native exposure, settings migration, test corpus; no keyboard UI rewrite.
3. **Phase 1B**: context-aware insertion + conservative Undo, keyboard style affordance, configurable durations, setup checklist; preserve authenticated transport and agent behavior.
4. **Phase 1C**: on-phone regression/perf/permission validation and user documentation.
5. **Phase 2A**: shared native recording coordinator + App Intents + explicit dictation clipboard completion; native state machine tests before adding controls.
6. **Phase 2B**: Live Activity, Stop/Cancel, Control Widget, Action Button/Back Tap/Siri onboarding, target packaging and signing checks.
7. **Phase 2C**: optional guarded Apple Intelligence cleanup, availability UI, device tests and documentation.

**Per PR deliverables:** linked requirements IDs, concise design rationale, code and fixtures, tests run, device/software/build identification, before/after latency and memory where relevant, screenshots/video only if they clarify UX, and limitations not yet verified. Keep PRs small and avoid unrelated desktop refactors.

### Definition of done
- Every `P1.*` and `P2.*` requirement is implemented or explicitly marked blocked/changed by an agreed architectural decision.
- Both Phases preserve the single-flight dictation/agent contract and no-duplicate insertion; no unauthorized MCP action or unexpected recording.
- Real-device evidence exists for any capability claimed to work in background/lock screen.
- No new paid API or unavailable extension API is required.
- User-facing docs accurately reflect supported features; native code ships in a Release IPA, not just OTA.

## 7. Source index: research for implementation

The following direct **code citations** are pointers for Codex research, not instructions to copy Hex wholesale. Compare against Hex `dev` for upstream changes before writing code. Hex and Shuddhalekhan are both MIT-licensed; retain the [Hex license notice](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/LICENSE) for any substantial copied source and record provenance in the PR.

| Topic | Hex reference | Shuddhalekhan reference |
| --- | --- | --- |
| iOS design, status, hardware proof gaps | [ios/README.md](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/README.md) | [mobile/README.md](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/README.md) |
| Styles, format, spacing | [TranscriptFormatter.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXShared/TranscriptFormatter.swift) | [keyboard controller](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/targets/transcript-keyboard/KeyboardViewController.swift) |
| Vocabulary/settings | [CustomVocabularySettings.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXShared/CustomVocabularySettings.swift), [VocabularySpelling.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXShared/VocabularySpelling.swift) | [SettingsScreen.tsx](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/src/ui/SettingsScreen.tsx), [speech module](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/modules/shuddhalekhan-speech/ios/ShuddhalekhanSpeechModule.swift) |
| Tests for vocabulary, formatting, guard | [CustomVocabularyTests.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobileTests/CustomVocabularyTests.swift), [KeyboardBridgeTests.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobileTests/KeyboardBridgeTests.swift), [TranscriptCleanupTests.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobileTests/TranscriptCleanupTests.swift) | [native checks](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/native-checks/KeyboardSessionCheck.swift), [scripts/build-ios.sh](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/scripts/build-ios.sh) |
| Expiry/races/cancellation | [DictationController.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobile/DictationController.swift), [DictationControllerTests.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobileTests/DictationControllerTests.swift) | [KeyboardSessionHost.swift](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/modules/shuddhalekhan-speech/ios/KeyboardSessionHost.swift), [KeyboardSessionProtocol.swift](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/modules/shuddhalekhan-speech/ios/KeyboardSessionProtocol.swift) |
| Keyboard setup | [KeyboardSetup.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobile/KeyboardSetup.swift) | [SettingsScreen.tsx](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/src/ui/SettingsScreen.tsx) |
| App Intents | [HexIntents.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobile/HexIntents.swift), [HexActivityAttributes.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXActivity/HexActivityAttributes.swift) | [useMobileApp.ts](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/src/useMobileApp.ts), [app.json](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/app.json) |
| Control Center | [HexDictationControl.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXWidgets/HexDictationControl.swift), [HexControlIntents.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXActivity/HexControlIntents.swift) | [AgentLiveActivity.swift](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/targets/agent-activity/AgentLiveActivity.swift) |
| Live Activity | [LiveActivityCoordinator.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobile/LiveActivityCoordinator.swift) | [AgentActivityManager.swift](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/modules/shuddhalekhan-agent-activity/ios/AgentActivityManager.swift) |
| Foundation Models cleanup | [TranscriptCleanup.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXMobile/TranscriptCleanup.swift), [AppleIntelligenceCleanupSettings.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXShared/AppleIntelligenceCleanupSettings.swift) | [native speech module](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/modules/shuddhalekhan-speech/ios/ShuddhalekhanSpeechModule.swift) |
| **Do not port** keyboard private-API workaround | [ContainingAppOpener.swift](https://github.com/anomalyco/hex/blob/8bc6e45a6b28686e28cbb2ab3dbcee1849610c62/ios/HEXKeyboard/ContainingAppOpener.swift) | [current keyboard opener and session flow](https://github.com/PeeeBrain/shuddhalekhan/blob/7e0f7258ac33fb536af294f3d6fb7b4698cf89e7/mobile/targets/transcript-keyboard/KeyboardViewController.swift) |

### Official Apple references
- [App Intents](https://developer.apple.com/documentation/appintents)
- [AudioRecordingIntent (Live Activity requirement)](https://developer.apple.com/documentation/AppIntents/AudioRecordingIntent)
- [LiveActivityIntent](https://developer.apple.com/documentation/AppIntents/LiveActivityIntent)
- [App Shortcuts HIG](https://developer.apple.com/design/human-interface-guidelines/app-shortcuts)
- [ControlWidget](https://developer.apple.com/documentation/swiftui/controlwidget)
- [Creating system controls with WidgetKit](https://developer.apple.com/documentation/widgetkit/creating-controls-to-perform-actions-across-the-system)
- [Foundation Models](https://developer.apple.com/documentation/FoundationModels/)
- [Foundation Models generation and availability](https://developer.apple.com/documentation/FoundationModels/generating-content-and-performing-tasks-with-foundation-models)
- [Foundation Models language support](https://developer.apple.com/documentation/foundationmodels/supporting-languages-and-locales-with-foundation-models)
- [App extension API limitations](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionOverview.html)
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)

**Out-of-scope follow-on:** optional QWERTY keyboard, Hex-like combined voice key and full-keyboard typing engine, auto-return-to-host-app experiments, and any keyboard-level app switching. These belong to Phase 3, with separate App Store policy review.
