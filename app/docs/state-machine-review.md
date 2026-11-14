# State ownership review

The initial inventory contained 89 groups, including partially explicit models, resource lifetimes, and two landing-page demos. It identified state, not 89 proven defects. This review records the disposition of every group after the council assessment and implementation.

Changes use local state variants or existing operation identity. No state-machine dependency, new user configuration, native iOS code, or provider-specific copy of shared runtime logic was added. Independent facts such as microphone session expiry and utterance phase stay separate.

The main behavioral fixes prevent work from retaining authority after cancellation, replacement, settings changes, or unmount. Renderer/main agent configuration synchronization uses the typed `agent:config-changed` event so saved discovery and approval policy updates reach an open Settings window.

| Inventory id | Owner | Disposition | Reason |
| --- | --- | --- | --- |
| D01 | [Recording session, partial](../src/main/recording-session.ts) | Changed | Recording startup is a phase; cancellation reaches the renderer before command retirement. |
| D02 | [Main-to-renderer capture ownership](../src/main/runtime-shell.ts) | Changed | Composition regression verifies command cancellation before shell cleanup. |
| D03 | [Renderer audio command handoff](../src/renderer/App.tsx) | Changed | One command owner replaces capturing/stopping refs and revision bookkeeping. |
| D04 | [Browser microphone and worklet lifetime](../src/renderer/audio-capture.ts) | Retained | Starting and draining captures genuinely coexist; release already stops late microphone streams. |
| D05 | [Worklet credit and end protocol](../src/renderer/audio-capture-worklet.js) | Retained | Bounded credits, batching and terminal stop latch represent independent facts. |
| D06 | [Realtime preview backpressure](../src/renderer/audio-capture.ts) | Retained | Preview disable is a one-way latch independent of canonical audio spooling. |
| D07 | [Streaming recognition and batch fallback](../src/main/recording-session.ts) | Retained | Failure retains recognized text; cancellation is idempotent and queues guard the active run. |
| D08 | [Transcript ledger validity](../src/main/streaming-transcript.ts) | Retained | Sticky protocol failure and monotonic sequence checks are sufficient. |
| D09 | [WhisperLiveKit WebSocket](../src/main/whisper-live-kit.ts) | Changed | One socket phase prevents duplicate or cancelled handshake finalization. |
| D10 | [WhisperLiveKit readiness](../src/main/whisper-live-kit.ts) | Retained | Sequential bounded health/handshake probing already returns explicit statuses. |
| D11 | [Clipboard-sandwich transaction](../src/main/clipboard-transaction-manager.ts) | Retained | The transaction scope and finally block own clipboard restoration. |
| D12 | [Delivery and Last Transcript recovery, partial](../src/main/index.ts) | Changed | Retry owns an abort controller and transcript; replacement and errors settle safely. |
| D13 | [Hotkey gesture recognition](../src/main/native/keyboard.ts) | Retained | Gesture and release lock can intentionally coexist; do not make them exclusive. |
| D14 | [Linux shortcut backend recovery](../src/main/native/keyboard.ts) | Retained | Backend identity, generation and bounded retries guard reconnect installation. |
| D15 | [Shell presentation arbitration](../src/main/runtime-shell.ts) | Retained | Concurrent presentation facts intentionally survive Dictation preemption; derive selects visibility. |
| D16 | [Desktop reply eligibility](../src/main/index.ts) | Changed | Reply history is installed only by the latest completed execution. |
| D17 | [Sidecar generation](../src/main/agent-sidecar.ts) | Changed | One generation state owns queued messages or shutdown settlement. |
| D18 | [Agent admission, replacement and shutdown](../src/main/index.ts) | Changed | Run id and controller belong to an execution; stale callbacks lose authority. |
| D19 | [Provider test ownership across layers](../src/renderer/settings/AgentSettings.tsx) | Retained | Request id, resolver, deadline and config revision already own provider-test settlement. |
| D20 | [Sequential desktop tool approvals](../src/agent/index.ts) | Retained | Approval queue and correlated waiter remain explicit; D18 adds execution ownership. |
| D21 | [MCP desired connection lifecycle](../src/agent/mcp-registry.ts) | Changed | Removed/reconfigured connection attempts retire their OAuth resources. |
| D22 | [MCP connection leases and retirement](../src/agent/mcp-registry.ts) | Changed | Explicit active/retired/closing/closed lifecycle preserves leased clients. |
| D23 | [MCP stdio drain and shutdown](../src/agent/managed-stdio-transport.ts) | Retained | Close promise, stream drain and once-only notification serve distinct lifetimes. |
| D24 | [MCP OAuth callback and credential progression](../src/agent/oauth-provider.ts) | Changed | OAuth listener/waiter owns settlement; close cancels and malformed callbacks remain retryable. |
| D25 | [Memory proposal acknowledgement and invalidation](../src/agent/memory-committer.ts) | Retained | Request/run ids, timeout and memory revision already reject stale writes. |
| D26 | [Skill import authorization](../src/main/agent-context.ts) | Changed | A newer folder selection invalidates completion of an older dialog. |
| D27 | [Local engine selection, leases and fallback](../src/main/managed-local-engine.ts) | Retained | Loading/selected worker ownership, leases and generation guards represent actual overlapping work. |
| D28 | [Utility worker startup and request queue](../src/main/managed-local-runtime.ts) | Changed | Utility-process messages require the current child identity. |
| D29 | [CUDA readiness verification](../src/main/managed-local-process.ts) | Retained | GPU placement and worker readiness are independent prerequisites. |
| D30 | [Model artifact installation, partial](../src/main/managed-local-model.ts) | Retained | Install status, staging transaction and single-flight promise already own installation. |
| D31 | [KDE insertion setup, partial](../src/main/kde-wayland-delivery.ts) | Retained | Named setup phase plus generation guards own setup; external resource liveness remains separately checked. |
| D32 | [RemoteDesktop portal session and key dispatch](../src/main/desktop/remote-desktop-keyboard.ts) | Retained | Setup and paste are separate operations; teardown rejects waiters and releases held keys. |
| D33 | [GlobalShortcuts portal binding](../src/main/desktop/global-shortcuts-portal.ts) | Retained | Request correlation, session binding and held-key retirement already enforce the protocol. |
| D34 | [X11 shortcut protocol, grabs and keymap refresh](../src/main/desktop/x11-shortcuts.ts) | Retained | Serialized rebind and deferred remapping preserve active chord semantics. |
| D35 | [KWin focus tracker](../src/main/desktop/kde-focus.ts) | Retained | First-report barrier, liveness and focus epoch enforce target freshness. |
| D36 | [D-Bus connection, framing and RPC settlement](../src/main/desktop/dbus.ts) | Retained | RPC correlation and framing buffers are necessary protocol state; shutdown settles waiters. |
| D37 | [X11 clipboard ownership monitor](../src/main/native/x11-clipboard.ts) | Retained | Connection lifetime and clipboard sequence are sufficient. |
| D38 | [Startup readiness barrier](../src/main/runtime-readiness.ts) | Retained | Two readiness prerequisites and a once-only latch are independent facts. |
| D39 | [App quit coordination](../src/main/index.ts) | Retained | Three quit phases are already guarded; conversion would be cosmetic. |
| D40 | [ChatGPT account authentication](../src/main/chatgpt-auth.ts) | Retained | Account revisions and shared refresh promise already invalidate stale credentials. |
| D41 | [Update orchestration, partial](../src/main/updater.ts) | Retained | Status variants and version checks already protect asynchronous release-note updates. |
| D42 | [Audit history reconstruction](../src/main/audit-summary.ts) | Retained | Ordered event replay is the state transition algorithm. |
| D43 | [Audit reader selection and migration](../src/main/audit-db.ts) | Retained | Reader lifetime, sticky fallback and transactional migration are separately bounded. |
| S01 | [Model/tool/approval loop](../../packages/shared/src/agent-loop.ts) | Retained | Loop budget and approval suspension are already explicit control flow; covered through runtime and mobile tests. |
| S02 | [Stream-to-step assembly](../../packages/shared/src/agent-loop.ts) | Retained | Step assembly is already covered by streamed-delta/tool tests in the runtime suite. |
| S03 | [Context compaction history](../../packages/shared/src/agent-loop.ts) | Retained | Compaction returns compacted history; removed results remain placeholders in replies without retaining a cross-run Set. |
| M01 | [Foreground command controller, partial](../../mobile/src/controller.ts) | Changed | Cleanup phase and abort controller share one operation owner. |
| M02 | [In-app recorder and file ownership](../../mobile/src/useMobileApp.ts) | Retained | Recorder preparation and temporary file cleanup use try/finally. |
| M03 | [Keyboard microphone session lifetime, partial](../../mobile/modules/shuddhalekhan-speech/ios/KeyboardSessionHost.swift) | Retained | Native session phase, expiry and deferred utterance completion already have guards. |
| M04 | [Native utterance and audio sink, partial](../../mobile/modules/shuddhalekhan-speech/ios/KeyboardSessionHost.swift) | Retained | Protocol transitions, request identity and cancelled-task guards protect utterance completion. |
| M05 | [Keyboard Agent Mode admission handshake](../../mobile/modules/shuddhalekhan-speech/ios/KeyboardSessionHost.swift) | Retained | Native admission timeout and JS request deduplication guard handoff. |
| M06 | [Keyboard extension connection and discovery](../../mobile/targets/transcript-keyboard/KeyboardViewController.swift) | Retained | Bridge identity and first-state acknowledgement guard socket admission. |
| M07 | [Keyboard request acknowledgement and insertion](../../mobile/targets/transcript-keyboard/KeyboardViewController.swift) | Retained | Pending request identity and inserted-id set enforce matching, once-only insertion. |
| M08 | [Persisted keyboard launch intent](../../mobile/targets/transcript-keyboard/KeyboardViewController.swift) | Retained | Persisted launch intent has freshness and consume-before-start semantics. |
| M09 | [Keyboard listener, authentication and utterance ownership](../../mobile/modules/shuddhalekhan-speech/ios/KeyboardSessionServer.swift) | Retained | Authenticated client sets and owner commands guard disconnect cancellation. |
| M10 | [Keyboard socket channel and frame decoder](../../mobile/modules/shuddhalekhan-speech/ios/KeyboardSessionChannel.swift) | Retained | Bounded frame decoder and once-only channel close own socket lifetime. |
| M11 | [Native background execution ownership](../../mobile/modules/shuddhalekhan-agent-activity/ios/AgentActivityManager.swift) | Retained | Background task identifiers, expiry and keyboard-session support have distinct guarded lifetimes. |
| M12 | [Live Activity ownership and recovery](../../mobile/modules/shuddhalekhan-agent-activity/ios/AgentActivityManager.swift) | Retained | Activity ownership, adoption and record recovery are explicitly guarded. |
| M13 | [Native approval notification and action delivery](../../mobile/modules/shuddhalekhan-agent-activity/ios/AgentActivityManager.swift) | Retained | Durable approval record, expiry and OS action correlation already guard decisions. |
| M14 | [JS approval suspension and resume](../../mobile/src/controller.ts) | Retained | Resolver is claimed once; native resume must succeed before tools continue. |
| M15 | [Mobile reply, retry and saved-result eligibility](../../mobile/src/controller.ts) | Retained | Conversation, retry history and saved display result intentionally have different lifetimes. |
| M16 | [Parakeet model residency and serialized work](../../mobile/modules/shuddhalekhan-speech/ios/ShuddhalekhanSpeechModule.swift) | Retained | Native speech queue serializes model replacement and inference, including cancellation drain. |
| M17 | [Mobile ChatGPT account](../../mobile/src/chatgpt.ts) | Retained | Serialized revision-guarded secure writes and single-flight refresh prevent session revival. |
| M18 | [Native ChatGPT browser and loopback redirect](../../mobile/modules/shuddhalekhan-chatgpt/ios/ShuddhalekhanChatGptModule.swift) | Retained | Browser generation and single-use continuations already guard native sign-in. |
| M19 | [Mobile MCP session, reply stream and discovery](../../mobile/src/mcp.ts) | Retained | Session, RPC id and cursor validation enforce initialization and discovery. |
| M20 | [Secure settings generation transaction](../../mobile/src/settings-storage.ts) | Retained | Staged secret generation and metadata commit already form a transaction. |
| M21 | [Mobile settings and approval presentation](../../mobile/App.tsx) | Retained | Retained sheet content is presentation state; only the current approval can be approved. |
| M22 | [Foreground deep-link readiness and keyboard-session hook](../../mobile/src/useMobileApp.ts) | Retained | Foreground admission and listener-first initial snapshots already guard ordering. |
| U01 | [Settings optimistic save and rollback](../src/renderer/settings/use-settings-persistence.ts) | Retained | Optimistic transcription saves already have revisions and rollback; unrelated settings stay independent. |
| U02 | [Shortcut capture and warning confirmation](../src/renderer/settings/ShortcutsSettings.tsx) | Changed | Shortcut capture owns async startup, cancellation and warning confirmation. |
| U03 | [Onboarding microphone check and completion](../src/renderer/settings/Onboarding.tsx) | Changed | Microphone ownership begins before permission resolves and ends on unmount. |
| U04 | [Audit list/detail loading and refresh](../src/renderer/settings/AuditHistorySettings.tsx) | Changed | Run-stamped detail state prevents same-selection loading hangs. |
| U05 | [Skill editing and import review](../src/renderer/settings/SkillsSettings.tsx) | Retained | Editor union and serialized mutations already own file operations. |
| U06 | [Memory editing and destructive confirmation](../src/renderer/settings/MemorySettings.tsx) | Retained | Revisioned memory edits and pushed-snapshot guards reject stale mutation results. |
| U07 | [MCP server settings editor](../src/renderer/settings/McpSettings.tsx) | Changed | Settings receives canonical agent config after main-owned policy/discovery changes. |
| U08 | [Credential and provider setup controls](../src/renderer/settings/ui/CredentialControl.tsx) | Changed | Endpoint-check results are stamped and hidden when settings change. |
| U09 | [Account model-list loading](../src/renderer/settings/AgentSettings.tsx) | Retained | Account stamps and effect cleanup guard model-list results. |
| U10 | [Runtime snapshot acceptance and action submission](../src/renderer/RuntimeShellSurface.tsx) | Changed | Recovery failures settle with copy actions; stale retries cannot affect a new recording. |
| U11 | [Response auto-follow and resizing](../src/renderer/RuntimeShellSurface.tsx) | Retained | Tail-follow preference and resize coalescing are independent presentation choices. |
| U12 | [Recording pill visibility and waveform scheduling](../src/renderer/RecordingPopup.tsx) | Retained | Visibility phases are named; waveform parks while silent or hidden. |
| U13 | [iOS Settings draft and tool discovery](../../mobile/src/ui/SettingsScreen.tsx) | Retained | Draft save/discard and tool-discovery union already have guarded cancellation. |
| U14 | [Keyboard screen transition and delete repeat](../../mobile/targets/transcript-keyboard/KeyboardViewController.swift) | Retained | Animation generation and timer cleanup protect keyboard transitions and delete repeat. |
| U15 | [Settings snapshot synchronization](../src/renderer/settings/use-managed-local-snapshot.ts) | Changed | Agent config pushes keep discovered tools and saved approval policies in the Settings snapshot. |
| R01 | [Audio spool](../src/main/audio-spool.ts) | Retained | Nullable descriptor and finally cleanup fully express the spool resource lifetime. |
| R02 | [Singleton windows](../src/main/window-factory.ts) | Retained | Nullable singleton handle delegates loading/visibility to Electron. |
| R03 | [Audit writer](../src/agent/audit.ts) | Retained | Idempotent close and status deduplication are separate bounded concerns. |
| R04 | [Temporary native background publication](../../mobile/modules/shuddhalekhan-agent-activity/ios/ActivityPublication.swift) | Retained | Background publication assertion already ends once. |
| W01 | [Dictation demo, partial](../../web/src/components/landing/DictationDemo.tsx) | Retained | Scripted marketing demo with named phases; no production ownership defect found. |
| W02 | [Agent demo, mostly explicit](../../web/src/components/landing/AgentSection.tsx) | Retained | The scripted advance function already declares its transitions. |

## Verification decisions

Windows and Linux use the same changed recording, sidecar, worker and renderer code. Portal, X11 and KDE owners retain their existing guards. Dictation, Agent Mode, tray recovery, Settings, mobile in-app recording, keyboard Agent Mode and Live Activity paths have focused automated coverage. Remote batch providers retain the common lifecycle; WhisperLiveKit adds a socket phase; Managed Local adds current-process message checks. Shared agent providers and tool policies retain their contracts.

The iOS change is JavaScript-only controller ownership. Native microphone, keyboard and background execution models retain their existing guarded transitions, so no new IPA or production OTA is part of this PR. Phone behavior is not established by desktop tests.

The council suggestion that shared runtime behavior had no tests was rejected: desktop runtime tests cover budgets, sequential approval pauses and streaming assembly, and mobile agent tests exercise the shared loop with local HTTP fixtures. A compactor's removed results already survive reply turns as placeholders in the returned history; carrying its internal Set between runs is unnecessary.

Source-level and automated checks do not establish microphone hardware, live OAuth provider or compositor behavior. These limits belong in the PR proof, alongside exact commands and results.
