# Desktop Dictation overhaul implementation plan

Status: implementation started for [#240](https://github.com/PeeeBrain/shuddhalekhan/issues/240) on 2026-11-06. Baseline: `6737d3c`, which includes merged #239. Product decisions now require previews plus final insertion and the original input context on Wayland. Backend certification remains open.

Implemented on 2026-11-07: AudioWorklet capture with bounded write credits, a private canonical PCM spool, verified final chunk/sample counts, correlated cancellation, pinned provider and formatter settings/credentials, one owner through final delivery, revisable previews, authoritative stream finals, and migration of Live settings to final insertion. The progressive Unicode controller and its supporting code are removed. Batch requests receive cancellation signals. The completed WAV is materialized once for the existing provider interfaces; very long final recognition can still require substantial RAM.

Linux activation now uses portal sessions or X11 grabs, with an explicitly reported evdev fallback. Settings displays assigned triggers and insertion support before recording. X11 target capture uses actual focused window/process identity, paste uses the server keymap through XTEST, and XFixes tracks clipboard ownership events. The fabricated Linux target, text-hash clipboard monitor, uinput paste device, and packaged udev rule are removed. A hidden development desktop identity enables portal registration and is cleaned up on quit.

The isolated Xvfb checks passed nine cases: focused-child identity, absent focus rejection, same-owner clipboard reacquisition, paste through a remapped V key, real shortcut press/release and held state, competing key grabs, live keymap rebinding, moved Num Lock, and refusal when a symbol is absent. Production renderer output emits the worklet as a separate JavaScript asset; executing that asset preserved its partial tail and stop acknowledgement. These checks do not certify everyday target applications or real desktop placement. Windows hardware, real X11 applications, GNOME/KDE automatic delivery, full performance budgets, and installation/upgrade certification remain open.

The completed [receiver investigation](receiver-context-feasibility.md) demonstrates that compositor validation alone leaves a toolkit delivery race. [AT-SPI investigation](receiver-atspi-feasibility.md) also found that stock toolkits accept object-addressed edits after focus is lost, and several required app classes cannot receive them. Its probes and build artifacts were archived outside the repository. Strict GNOME/KDE automatic delivery is blocked on receiving-side changes; copy recovery does not close that gate.

Follow-up implementation closes the microphone-readiness and disconnect gaps. The pill starts in preparation; only a current-renderer, current-command readiness message starts its timer and provider duration limits. Main also bounds startup when the renderer never becomes ready. Track termination during startup, recording or draining fails the capture and releases resources; stale track events are detached. Electron 43.1 still lacks native Wayland overlay anchoring/placement and non-activating show APIs, so XWayland remains the selected window backend. Removing its launch flag would lose supported overlay behavior. The [receiver implementation status](receiver-implementation-status.md) records the remaining external integration requirements; no strict production receiver is shipped.

Follow-up checks passed 541 tests across 37 focused files, with eight opt-in checks skipped, plus app typecheck, app lint and `git diff --check`. The tests exercise capture readiness correlation, delayed/duplicate/foreign readiness, startup expiry, provider limits beginning at readiness, and microphone termination during setup, recording and spool drain. No app, browser, compositor or additional hardware session was launched for this follow-up.

Live KDE best-effort trial, 2026-11-07: after the maintainer explicitly accepted the residual focus race for a test build, the implementation added KWin window tracking and a keyboard-only RemoteDesktop session. The live tracker returned a valid window identity. A real spoken recording produced the correct transcript, as confirmed by the maintainer through copying. The best-effort setting was initially off; enabling it successfully established keyboard control and reported insertion ready. The maintainer then confirmed automatic insertion worked. This verifies a real end-to-end attempt on the current KDE session; it does not establish strict field identity, other target-app coverage, or GNOME/Windows certification. The mode leaves the transcript on the clipboard and requires keyboard-control setup again after launch.

Offline decoder decision: use one whole-recording final decode for both installed models. The pause-segmentation experiment used 24 synthesized sentences across five voices and one bundled human clip on a Ryzen 7 7840HS CPU. In the constructed mid-sentence-pause case, segmented Parakeet had 6.09% WER against a 4.57% whole-input result; segmented Granite had 6.09% against 5.08%. Granite improved some quiet-speech cases, but there is no approved accuracy-regression budget or representative real-speaker corpus. Neither segmented implementation is a shipping dependency. Removing the incremental worker path also removes its second retained recording and queued per-pause work. Long utterances now incur final processing after stop. The opt-in eval runner and externally archived logs/candidate sources preserve the experiment for a future measured decision.

Final integration verification, 2026-11-07: the focused grouped run passed 534 tests across 36 files, with eight opt-in checks skipped. The model-file deletion fixture passed separately, since its existing global config mock conflicts with main-process fixtures in a shared Bun process. All four preflight tests passed with their integration flag enabled. App typecheck, app lint and `git diff --check` passed. The nine native X11 checks and emitted-worklet check described above were run earlier in this implementation session. No real microphone/Electron session, Windows hardware, release package installation or representative target-app certification was performed. Original-field delivery on stock Wayland remains an open blocker, so this is not completion of #240.

KDE hardening and measurements, 2026-11-07 (Fedora 45, Plasma 6.8.2, Ryzen 7 7840HS, CPU inference):

- KWin tracker liveness now gates readiness. Real KWin: a SIGKILLed tracker left `shuddhalekhan-focus` loaded; the next setup unloaded it, captured the active window, and `close()` unloaded it. SIGTERM of the dev app and of the packaged `linux-unpacked` build also unloaded it. KWin restart (tracker-loss notification) is covered only by the fake-bus test.
- Recognition before/after, same 117.5 s phrase recording with 30 to 48 pauses (`scripts/eval/incremental.ts`; old incremental run from the archived evidence):

  | Model | Path | Audio decoded | Stop → final | WER |
  | --- | --- | --- | --- | --- |
  | Parakeet | old per-pause whole-prefix | 1325 s (11.3×) | 21.5 s | 4.06% |
  | Parakeet | shipped single final decode | 117.5 s (1×) | 8.1 s | 4.57% |
  | Granite | old per-pause whole-prefix | 2725 s (23.2×) | 1.9 s | 5.08% |
  | Granite | shipped single final decode | 117.5 s (1×) | 2.5 s | 5.08% |

  Short 2–3 s utterances: old stop latency ~0 ms (already decoded at the pause), shipped 109–147 ms (Parakeet). Same-input WER is unchanged from a whole decode, and the 0.5-point Parakeet difference matches the earlier segmentation finding.
- Idle dev app (KDE best-effort on, warm Parakeet worker, Agent Mode with one MCP server): 0.53% of one core over 30 s across 13 processes; no microphone stream open (PipeWire source outputs empty). PSS 1316 MiB, of which the warm model worker is 752 MiB and the dev-only Vite server 194 MiB.
- Proposed regression budgets for this hardware (maintainer approval pending): short-utterance stop → final ≤ 250 ms (Parakeet CPU); 2-minute stop → final ≤ 10 s Parakeet / ≤ 3 s Granite; decoded audio = recorded audio; idle CPU < 1% of one core; no open microphone while idle.
- The rpm builds with `electron-builder --linux rpm`; it carries no udev/uinput rule or group change and installs `shuddhalekhan.desktop`. Running `linux-unpacked` without that file installed makes GlobalShortcuts refuse registration ("An app id is required"), as expected. Installed-rpm check on Fedora 45 KDE Wayland (2026-11-07):
  - `dnf install` added the alternatives link and desktop file and no udev rule. KDE registered the `shuddhalekhan` GlobalShortcuts component (F2, F8) and it was active.
  - Two real F2 taps from a temporary uinput keyboard recorded 5.3 s from the default mic, ran Parakeet, and released the mic. With no speech the run correctly reported "No speech recognized". KGlobalAccel `invokeShortcut` sends only `Activated`, so it cannot test toggling.
  - The mic ID saved by the dev app failed in the packaged build with `OverconstrainedError`: the two builds share `shuddhalekhan-config.json`, but Chromium salts device IDs per profile (`~/.config/Electron` versus `~/.config/Shuddhalekhan`). The app fails closed with an accurate message; product code is unchanged.
  - Bug found and fixed: upgrading deleted `/usr/bin/shuddhalekhan`. rpm runs the old `%postun` after the new `%post`, and electron-builder's stock script ignores `$1`. `packaging/linux/after-remove.sh` (rpm only) now exits early when `$1 >= 1`. It also removes the empty directory tree that fpm leaves in `/opt/Shuddhalekhan`. Verified: fixed 0.0.1 → 0.0.2 keeps the link, and uninstall removes the link, desktop file and `/opt` tree. No rpm has been released yet, so no installed base hits the old script.
- No-speech failures now distinguish a nearly silent input from clipping. A later live no-speech log (`peak 1, rms 0.86`) was saturated input, not a converter fault: the context runs at 16 kHz and conversion is a clamped identity.

## Recommended final system

Keep Electron, React, and the existing agent sidecar unless the platform feasibility work demonstrates a concrete blocker. A shell rewrite does not itself provide Wayland input-context access. Replace the Dictation orchestration and native integration as needed, without preserving their current internal APIs.

Use one recording session for capture, recognition, optional cleanup, and final routing. Stream recognition whenever the selected engine supports it. Show revisable text in the recording pill, then attempt automatic delivery once after stopping. Batch-only providers use the same lifecycle without previews. Agent Mode sends one final command to its existing entry point.

The maintainer selected previews plus final insertion, replacing progressive external typing. Migrate saved Live settings deliberately when the replacement ships. Do not maintain the existing append-only keystroke path as the new cross-platform model.

The maintainer also requires the original input context on Wayland. Portal input into whichever field is focused at dispatch cannot satisfy that contract. Prove an input-method backend before choosing the Wayland delivery architecture. Losing the captured context cancels automatic delivery and preserves Last Transcript; returning focus must not silently revive an invalidated delivery.

The maintainer authorized receiver/compositor investigation while retaining strict safety. The resulting findings distinguish protocol-context validation from application field identity. Experimental desktop forks are not product dependencies.

Use a small, statically selected desktop host for activation and delivery. Native handles and clipboard transactions stay inside that host. Recognition code never sees Windows handles, Linux keycodes, clipboard ownership, or paste chords.

The intended sequence is:

1. A registered shortcut starts a session with pinned settings and an explicit delivery target or target policy.
2. AudioWorklet capture supplies bounded PCM transport to the selected recognition engine.
3. Session snapshots drive preparation, recording, previews, and finishing feedback.
4. Stop drains capture through an acknowledged final audio boundary, then finishes recognition.
5. Dictation optionally cleans up the final transcript and delivers once. Agent Mode hands its transcript to the sidecar once.
6. The terminal result records what is known about delivery and preserves recoverable text.

## Decisions that must precede the rewrite

| Decision | Recommendation | Evidence required to close it |
| --- | --- | --- |
| Default text behavior | Accepted: preview while speaking, final delivery after stop | Implement and test the saved Live migration with an explanation |
| Shell | Keep Electron initially | Native Wayland capture, overlays, activation, and delivery work in the pinned runtime |
| Wayland delivery | Prove a real input-method context backend first | Real automatic insertion on both GNOME and KDE with acceptable setup and context lifetime |
| Wayland target safety | Accepted: require the original input context | Context invalidation, stale-result rejection, and field-reuse limitations demonstrated in actual apps |
| Native bridge | Use existing Windows FFI where adequate; one Linux bridge only where needed | Minimal API probe, reproducible build, event and file-descriptor handling, shutdown/crash proof |
| Hold activation and modifier-only bindings | Offer only when the chosen registration implements them | Actual release events, chord suppression, rebinding, and conflict tests |
| Local incremental decoding | Native streaming where the selected model supports it; bounded segments for suitable offline models | Accuracy and decoded-work comparison using current model families |
| Recording retention | Preserve long-form use with bounded memory; use one temporary canonical spool if necessary | Explicit duration/storage policy, fallback compatibility, disk-full and cleanup behavior. A new duration cap needs a product decision. |

Do not hide a failed decision behind copy-only delivery or a newly fabricated target. If no native path meets the selected contract on one required desktop, the feasibility milestone remains open. Bring back the exact conflict and a concrete alternative before expanding the rewrite.

## What the merged code requires us to replace

| Current owner | Problem or contract to retain | Planned change |
| --- | --- | --- |
| `src/main/recording-session.ts` | Captures intent and recognition settings, but also owns streaming insertion and keyboard concerns | Make it the session owner through cleanup and delivery; remove insertion-specific transcript state |
| `src/main/index.ts` | `routeRecordingResult` performs cleanup and delivery after recording; reads current cleanup settings | Move Dictation completion into the session boundary; pin cleanup and credential selection at session start |
| `src/main/dictation-result-delivery.ts` | A separate latest-result marker guards late cleanup | Replace with the session's cancellation/generation check |
| `src/renderer/audio-capture.ts`, `src/renderer/App.tsx` | ScriptProcessor capture, synchronous stop, buffered WAV and streaming transport | Replace with AudioWorklet and asynchronous drain/acknowledgement |
| `src/main/transcription.ts`, `providers.ts` | Batch, streaming, and incremental methods already exist | Unify their session contract without rewriting every HTTP adapter unnecessarily |
| `src/main/managed-local-incremental.ts` and local runtime modules | Warm isolated inference, pause decoding, hardware policy and fallback | Preserve behavior; replace repeated whole-prefix work only with measured model-compatible handling |
| `src/main/native/target.ts`, `production-adapters.ts` | Linux returns a constant Windows-shaped target; shared adapters retain Windows names | Move concrete identity and validation into each desktop host |
| `src/main/clipboard-transaction-manager.ts`, `native/clipboard.ts` | Serialized delivery and dispatch accounting are useful; target check precedes staging | Keep serialization, strengthen ownership and revalidation, represent uncertain outcomes |
| `src/main/native/linux-input.ts`, `native/keyboard.ts` | Linux observes raw devices and pastes through uinput | Replace the default with desktop registration and supported delivery |
| `src/shared/dictation-runtime.ts`, `transcription-features.ts` | Live mode ties streaming to toggle activation and cleanup availability | Separate recognition, activation, cleanup, and delivery choices |
| `src/types/ipc.ts`, `src/preload/index.ts`, `runtime-shell.ts` | Typed capture and presentation correlations already exist | Evolve together; keep one authoritative session snapshot |
| `src/main/config.ts`, settings, onboarding | Existing preferences, model assets, credentials, and setup completion | Versioned migration and backend readiness that describes actual support |

Paths in this document are relative to `app/` unless they start with `.github/`.

## Implementation sequence

### 0. Prove the platform path and record the baseline

This is the first implementation work, not an open-ended architecture study. Build small probes that exercise the same native APIs the product would ship. Use a fixed transcript before connecting microphone or model code.

1. Record OS, desktop/compositor, portal backend versions, runtime version, architecture, package identity, and test applications. The current lockfile resolves Electron 43.1.0. Verify the installed desktop-file identity and portal association rather than relying on the configured `shuddhalekhan.desktop` name. Cover Windows, GNOME Wayland, KDE Plasma Wayland, and an actual X11 session. Native Wayland and XWayland target applications are distinct cases.
2. Prove shortcut registration, actual bound triggers, conflicts, denied/revoked permissions, activation/deactivation, and suppression. Test current modifier-only defaults separately from ordinary key chords. Requiring rebind is preferable to pretending an unsupported binding registered.
3. Probe automatic delivery into an editor, a browser field, a terminal, and an Electron app. Test Unicode, selection replacement, layouts, held modifiers, focus switches, clipboard ownership changes, and delayed readers.
4. Compare startup and steady-state cost, installation steps, native build time, and process lifecycle for the candidate bridge. Start with existing Windows FFI and an in-process Linux D-Bus probe, including clipboard file-descriptor transfer. Test the portal's D-Bus keyboard methods for the paste chord before adding libei or a compiled helper. Introduce a helper only if this path cannot provide the selected contract; then prove one build and lifecycle for it. Do not create multiple helpers for shortcuts, clipboard, and insertion independently.
5. Measure current Dictation using reusable audio fixtures and a small opt-in runner. Reuse `scripts/eval/` for transcript scoring where possible. Record cold/warm recognition, hotkey-to-first-audio, stop-to-final, final-to-dispatch, observed appearance in the target, decoded audio seconds, peak memory, active/idle CPU/GPU, and microphone release. Separate source-inferred risks from reproduced failures.

Platform candidates, in order:

| Environment | Activation candidate | Delivery candidate and limit |
| --- | --- | --- |
| Windows | Existing native hook for required hold/modifier behavior; compare registered chords for ordinary bindings | Harden existing clipboard/SendInput path and real target identity. Elevation can block it. Matching a window does not identify its tab, caret, or field. Evaluate TSF only if composition is required. |
| X11 | Native registered/grabbed shortcuts with real release events | Actual X11 focus identity and XTest dispatch, plus selection ownership tracking. Prove terminal strategy and clipboard restoration without uinput. |
| GNOME/KDE Wayland | Direct GlobalShortcuts session if release events are needed | Probe one input-method implementation first, starting with installed IBus. Compare IBus/Fcitx context lifetime, app coverage, ordinary typing, install/activation cost, and coexistence with the user's current input method. No assumed global focused-window query. |
| Wayland if IBus cannot meet the contract | Retain the proven activation mechanism | Evaluate the precise failure against Fcitx or a supported compositor integration. Do not ship both frameworks speculatively or replace the original-context requirement with current-focus paste. |

The [GlobalShortcuts protocol](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html) exposes activation and deactivation and returns the shortcuts actually bound. Use the desktop's resulting binding in Settings.

The [RemoteDesktop protocol](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html) grants input through a consented session. Test persistence, reconnect, and revocation rather than promising silent reuse. Request keyboard access only; screen capture is not a product requirement.

The [Clipboard portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Clipboard.html) extends another portal's session and exposes selection ownership and MIME transfers. It is not an independent global clipboard permission. Data transfer does not prove an application edited its document. If the remaining restoration race is unacceptable, that blocks certification of the clipboard path and requires a different delivery design or an explicitly accepted product contract.

Deliverables: a decision record under `docs/adr/`, the measured baseline, minimal probes, exact certification candidates, and the selected backend/target/clipboard contract. Set numerical regression budgets from that baseline before accepting replacements. Delete losing probes after the decision.

Exit gate: automatic insertion demonstrated on all four environment classes, with focus and clipboard limitations acceptable to the maintainer. A mock, XWayland-only app run, or successful Copy action cannot close this gate. Input-method proof is mandatory on Wayland even when portal injection works. Live Dictation's replacement behavior is decided; its migration remains implementation work.

### 1. Establish the session and host contracts

Depends on stage 0's decisions. Implement the chosen host, not a plugin registry.

- Create a small host entry point under `src/main/desktop/`, selected once at startup. It reports registration/readiness, emits intent activation/release, captures a delivery context, performs delivery, and closes its resources. Keep platform-specific clipboard operations private to it.
- Replace the Windows-shaped shared target with explicit variants for a native context, unknown identity, and unavailable/denied delivery. Keep handles opaque outside the host. Unknown is never equivalent to verified.
- Record delivery disposition separately from cause. Distinguish known no dispatch, partial dispatch, uncertain dispatch, OS dispatch, and context commit. An exception after dispatch starts must not become a retryable generic error.
- Make a single session owner retain the intent, capture generation, abort signal, provider/model, effective recognition settings, microphone, cleanup profile/consent, resolved credential access, target policy, and relevant delivery preferences. A settings edit affects the next session.
- Keep the session alive through draining, recognition, cleanup, and delivery. Reject competing starts with truthful busy feedback; explicit cancellation invalidates pending work. Finish exactly once.
- Preserve the existing agent-run entry point and correlation. Dictation does not start the sidecar or connect MCP. Agent transcripts never reach the delivery host.

Exit gate: deterministic tests show that cancel, supersession/crash generations, or late recognition/cleanup cannot start delivery; duplicate completion cannot route twice. Cancellation cannot retract events already dispatched, and the result must retain that uncertainty.

### 2. Ship one end-to-end Windows and Wayland flow

Depends on stage 1. Connect the chosen host and current capture/providers before replacing every subsystem.

- Enable recognition streaming independently of the chosen delivery behavior. Introduce replacement preview snapshots with monotonically increasing revision and session identity. Replace `streaming-transcript.ts`'s append-only prefix rule where it enforces external-typing constraints. The final provider result is authoritative; a valid final differing from the preview must not trigger whole-audio fallback. Never automatically deliver a partial preview after finalization fails; label retained partial text as incomplete.
- Keep partial output out of external applications in the recommended final-delivery model. Preserve batch providers without inventing streaming capabilities for them.
- Enable the selected native Wayland launch path now, including removal of the unconditional `--ozone-platform=x11` development/package switches where they defeat that selection. Check that the pill and toasts remain usable before expanding the rewrite.
- Route final Dictation through pinned optional cleanup and one delivery attempt. Save recoverable raw/final text appropriately before delivery. A cleanup failure falls back to the raw transcript with a truthful notice.
- Recheck the session and every target fact the backend can verify immediately before dispatch, including after clipboard staging or modifier waits. A mismatch preserves Last Transcript and does not refocus another app. Wayland requires the captured input context; unknown identity blocks automatic delivery.
- Exercise one Windows target and one real Wayland desktop with managed-local, WhisperLiveKit, and a batch endpoint, followed by Agent Mode using the same capture path.

Exit gate: speaking, revising previews, stopping, optional cleanup, and automatic delivery work on both OS families. Cancel during cleanup prevents a new dispatch. A detected target/context change during staging also prevents dispatch. Old Live behavior is removed together with its migration when the replacement is ready.

### 3. Replace capture and make buffering finite

Depends on stage 2. Replace `audio-capture.ts` rather than adding another parallel capture pipeline.

- Add a worklet module loaded correctly by electron-vite in development and packaged output. Downmix and resample at one defined boundary using the actual device rate. Keep allocation and React work out of the render quantum.
- Stop is asynchronous. The worklet selects the last accepted sample boundary, flushes resampler and partial packet output, and reports the final sequence/sample count. Main verifies contiguous frames through that sequence and waits for those packets to reach the recognition boundary before calling provider finish. Retire the active capture command only after its matching drain terminal is accepted; duplicate acknowledgements are idempotent.
- Correlate start/stop/ack/error by session and capture generation. Ignore obsolete acknowledgements. Bound startup, drain, and finalization; report an incomplete capture instead of quietly declaring success after a timeout.
- Use byte-counted transport limits and reusable typed chunks. Keep one canonical retained audio representation for declared same-provider fallback. Managed Local currently has no duration limit, so do not silently introduce one. Choose an accepted duration/byte limit with truthful stop behavior, or spool one canonical recording to a session-owned temporary file with bounded in-memory transport. Define disk-full, crash cleanup, and batch-provider materialization behavior. Do not retain multiple unbounded full recordings.
- If recognition cannot keep up, disable incremental transport and use retained complete audio only when that provider supports the fallback. Otherwise end with an explicit recoverable failure. Never silently skip accepted audio.
- Stop tracks and release all capture resources on cancel, denial, disconnect, startup races, renderer failure, timeout, and normal completion. A warm worker is allowed; an idle open microphone is not.
- Give cancellation its own command and acknowledgement. Currently `RuntimeShell.cancelCapture()` follows the stop path. The replacement must discard retained audio, stop tracks, and abort recognition without creating a WAV or calling provider finish.
- Keep level telemetry and transcript previews separately throttled. Neither should send a UI update per audio quantum.

Exit gate: deterministic sample fixtures protect the final partial packet and resampler tail across rates and channel counts. Controlled stop/ack tests prove finish ordering, overflow behavior, stale acknowledgements, and track release. Hardware evidence must separately check the suspected last-syllable loss.

### 4. Simplify recognition and remove repeated decode work

Can start after stage 1 on fixed audio; integrate after stage 3.

- Adapt batch, streaming, and incremental providers to one recording contract with capability-based previews, finish, and abort. Keep endpoint/model/language/translation/dictionary/auth semantics. Extend existing adapter tests where those semantics could change.
- Preserve worker reuse, verified downloads, offline availability, pinned hardware choice, bounded restart, and the existing same-provider CPU recovery policy. No provider or endpoint substitution to conceal failure.
- Treat current local models as offline implementations: Parakeet's artifact is non-streaming and uses `OfflineRecognizer`; Granite uses whole-input transcription. Native streaming is not an available switch. Start with bounded-segment feasibility for these artifacts. Any alternative runtime/assets need an explicit compatibility, download, and migration assessment.
- Measure `managed-local-incremental.ts` using short utterances and long recordings with many pauses. Record total decoded samples and stop-time latency, not only final transcript time.
- Implement native streaming only for a compatible selected model. For offline models, evaluate VAD-bounded segments with an explicit maximum segment size, bounded overlap, and final tail handling. Limit speculative decode concurrency and discard obsolete jobs. Never re-decode the entire recording at every pause by default.
- Compare word error rate, punctuation, quiet speech, vocabulary hints, mixed language, translation, and segment boundaries against the current same-model output. Keep an explicitly justified whole-utterance final decode for a model if segmentation violates its semantics or measured accuracy budget; do not hide it as streaming.
- Extend the existing eval runner with matched chunk-fed long/pause recordings and decoded-sample counters. Its current full-clip accuracy/latency path and Windows PowerShell e2e rig do not establish incremental-work or Linux results. Preserve Auto CUDA-to-CPU same-model retry while keeping explicit CUDA selection from silently falling back.

Exit gate: bounded queued work, no duplicate/lost boundary text, predictable cancel/restart, and a per-model decision backed by quality and performance results. Do not change the model catalog simply to simplify the implementation.

### 5. Finish native coverage and recovery

Extend the stage 2 host to the remaining certified desktops after the actual stage 0 probes have passed.

- Complete GNOME Wayland, KDE Plasma Wayland, and X11 registration, actual bound shortcut display, permission/revocation handling, sleep/resume, reconnect, and independent Agent Mode shortcut behavior.
- Obtain interactive desktop permissions during setup or an explicit repair action before declaring Dictation ready. Do not open a consent dialog after recognition, lose the intended focus, and then paste into a guessed destination.
- Finish native Wayland pill/toast placement, focus behavior, multiple monitors, fractional scaling, and interactive recovery across both desktops. Do not assume Wayland allows global window positioning.
- Keep dispatch and document acceptance distinct in presentation and onboarding. A portal reply or clipboard read is not proof text appeared. Use explicit user confirmation where setup cannot observe insertion.
- Paste backends serialize clipboard work and preserve only documented formats within stated limits. Stage all formats coherently, use native ownership/change tracking, and skip restoration after a detected newer owner/copy. Test copies made by the same application/selection owner too; unchanged owner identity alone is not a universal change counter. Where an API cannot detect a change or make check-and-restore atomic, record the remaining race and select an acceptable alternative before certification.
- Revalidate identity at the strongest supported granularity. Window identity does not detect every same-window tab/caret change. Prove the input method's actual context granularity, including toolkit reuse across fields, before claiming original-context support on Wayland.
- Permit a user-requested paste retry only after known zero acceptance and a new valid target check. Partial or uncertain delivery offers Copy and Last Transcript, never automatic full replay. Copy is an intentional clipboard replacement.
- Define helper/portal death recovery so the next session can reconnect without orphaned processes, input devices, grabs, or stuck keys.

Exit gate: every certified environment passes its declared automatic-delivery path and realistic clipboard/focus cases. Uncertified compositors get accurate support status and fallback without being counted as completion.

### 6. Migrate settings and delete the superseded system

Develop migration fixtures alongside the new config contract; apply the migration when replacement behavior is ready.

- Add a versioned, repeatable config migration at `config.ts`. Preserve the stable data directory, provider URLs/model choices, secret identifiers and encrypted vault, dictionaries, microphone, local assets, and both intent-specific shortcuts. Avoid moving credentials through the native helper.
- Map Batch to ordinary final delivery, Corrected to final delivery with the existing formatter/consent, and Live to previews plus final delivery with a one-time explanation. Preserve provider selection. Do not retain an obsolete mode solely to store migration history.
- Convert supported saved shortcut identities to the new registration format. Preserve requested activation style separately from actual backend availability. Mark unsupported modifier-only, hold, or conflicting bindings as needing rebind; do not silently change them.
- Update `TranscriptionSettings`, `ShortcutsSettings`, `Onboarding`, `SetupChecklist`, tray recovery, and runtime presentation to consume actual readiness and disposition. A setup failure must leave Settings and recovery reachable.
- After replacement tests pass, delete the Live insertion controller and append-only external-typing machinery if superseded, the standalone result-generation marker, fabricated Linux targets, obsolete Windows-shaped adapters, raw evdev/uinput default code, and corresponding dead tests.
- Remove `70-shuddhalekhan-uinput.rules`, its package mapping, and app-specific post-install udev steps once no shipped path uses them. Document cleanup for old installations; never remove a user's input-group membership automatically.
- Update `CONTEXT.md`, the chosen ADR, `CHANGELOG.md`, setup/development documentation, and native dependency instructions. Remove dependencies only when their remaining callers are gone. Koffi may still be needed on Windows.

Exit gate: pre-mode, Batch/Live/Corrected, legacy activation, provider/credential, and fresh-install fixtures migrate deterministically and survive restart without resetting user data. Ordinary Dictation remains usable with Agent Mode disabled.

### 7. Prove builds, desktop behavior, and improvement

- Keep normal iteration as root `bun install` and `bun run dev` on Windows/Linux. Integrate native preparation into the ordinary workflow with pinned toolchains/artifacts, platform/architecture coverage, and rebuild/debug instructions. Record the extra build time and processes introduced.
- Add focused Linux-native validation to `.github/workflows/ci.yml` as required by the selected bridge. Headless CI can verify contracts and native loading; it cannot certify real compositor permissions or insertion.
- Update `.github/workflows/release.yml` and Electron resources only for actual artifact changes. Test clean Windows installation and deb/rpm install, upgrade, uninstall, desktop identity, portal access, helper loading, and model reuse. Packaging checks belong to this stage, not every feature edit.
- Repeat the baseline corpus and desktop scenarios on the selected support versions. Publish variability and failures, target appearance evidence, accuracy, capture continuity, decoded work, memory, active/idle CPU/GPU, and microphone release. Compare cold and warm runs separately.
- Keep diagnostics local and limited to timing, counts, state, and redacted failures by default. Do not add transcript, audio, clipboard, or credential collection through benchmark or helper logging.
- Supply before/after images for changed UI and short recordings for timing or motion when opening implementation PRs. No continuously repainting idle recording UI.

Exit gate: #240's acceptance list has linked evidence for each certified platform, tests and migrations pass, performance/accuracy meet the predeclared budgets, and replaced systems and permissions are gone.

## Tests that earn their keep

Use the existing behavioral owners. Do not recreate the same case in `index.test.ts`, session tests, and host tests.

| Boundary | Failure to protect | Existing test owner to evolve |
| --- | --- | --- |
| Session | Cancel or old recognition/cleanup delivers later; Agent Mode routes twice or pastes into an app | `recording-session.test.ts`, focused result-routing cases in `index.test.ts` |
| Capture | Stop loses a partial block; finish runs before drain; microphone survives a failure | `renderer/__tests__/audio-capture.test.ts` plus the worklet/resampler boundary |
| Presentation | Old/revised preview overwrites a new session, rejects a valid final correction, or is shown as committed delivery | `streaming-transcript.test.ts`, `runtime-shell.test.ts`, renderer runtime/recording tests |
| Host delivery | Unknown target passes verification; focus changes during staging; uncertain dispatch becomes retryable | `clipboard-transaction-manager.test.ts`, `inject-text-target.test.ts`, `dictation-recovery.test.ts`, native target tests |
| Clipboard | Equal text from a newer owner is overwritten; supported rich formats disappear | Clipboard transaction and concrete native adapter tests |
| Recognition | A recording decodes repeatedly; fallback changes settings/provider; cancellation strands a worker | Existing local engine/runtime and provider tests |
| Migration/setup | Upgrade resets a provider/key/binding; unsupported hold looks registered; onboarding traps the user | `config.test.ts`, shared runtime/shortcut and settings tests |

Tests without an explicit path above are under `src/main/__tests__/`. For each implementation slice, run only its focused Bun tests, then app typecheck/lint when its shared types or integration warrants it. Full suite and packaging runs belong to the changed CI/release workflow or an explicit requested verification. Opt-in benchmarks stay out of ordinary `bun test`.

Native certification additionally covers elevated Windows targets, native Wayland/XWayland apps, actual X11, non-QWERTY layouts, Unicode and mixed-language text, terminal chords, same-process window changes, user copy during staging/restore, rich/image clipboard, immediate stop after speech, quiet/long speech, device disconnect, denial/revocation, shortcut conflict, suspend/resume, helper crash, and multiple displays. Record unsupported target classes honestly.

## Work order and review boundaries

The critical path is stage 0, then contracts, then the Windows/Wayland end-to-end flow. Capture and recognition work can proceed independently once their contracts are fixed. Remaining platform coverage and migration join before removal and release validation.

Keep each change reviewable around one working contract. Do not land a Windows-only rewrite before the Wayland flow works. Temporary old/new code may coexist during development with a named removal point; avoid permanent compatibility registries or user-facing experimental backend menus.

The first concrete work item is the stage 0 activation/delivery probe and decision record. The first product slice is final-on-stop delivery on Windows and one native Wayland desktop using current recognition. This order resolves the hardest product constraint before spending effort on audio or shell replacement.

## Evidence and limits of this plan

Inputs are [#240](https://github.com/PeeeBrain/shuddhalekhan/issues/240), the discussion at <t3-thread://v2/25ed6a33-1517-4f57-80bd-21cd272ad101/c6ba8d9b-655d-48da-b3ed-e258109c3e4d>, and source inspection of merged #239. Native Luna subagents at xhigh reviewed the platform and session/capture work. The plan allows reimplementation where it reduces the final system, while preserving provider access and user data.

The original planning pass did not certify desktop coverage, input-method app compatibility, clipboard preservation, speech-tail clipping, numerical latency, or build cost. Subsequent implementation evidence is recorded in [desktop-dictation-feasibility.md](desktop-dictation-feasibility.md), including the isolated native receiver tests. No shipping native backend is certified, and no implementation PR or issue update has been published.
