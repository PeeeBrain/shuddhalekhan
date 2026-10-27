# Mobile Swift audit

Reviewed on October 27, 2026 against the repository's [write-swift skill](../../.claude/skills/write-swift/SKILL.md). Findings below describe the source at the initial audit, before the fixes in this worktree. This report does not certify device behavior.

## Fixes applied

- The host retains and cancels its transcription task. `SpeechWorkQueue` owns cancellation and serial admission for inference, preparation, and installation. A cancelled operation retains admission until the underlying dependency returns; cancelled queued work never starts and cancelled results never escape.
- Listener startup now cancels its owned timeout on readiness, failure, or shutdown. Listener callbacks and timeouts verify their listener identity before accessing current state. Starting another listener first stops the previous attempt.
- Encoder replacement uses the same speech queue as inference. Concurrent requests for an already loaded model reuse the cache after their turn arrives.
- `KeyboardAudioStore` owns a dedicated temporary directory, logs cleanup failures without private paths, remembers failed removals, and retries before the next recording. Pending cleanup blocks more audio from accumulating. A new host also discovers and removes files left by a previous process.

`SpeechWorkCheck.swift` covers cancellation of running and queued work, encoder admission, caller cancellation, failed deletion and retry, and previous-process cleanup. The existing transport check now restarts the same listener owner. Both checks are wired into the Release build script.

Verification completed:

- Mobile typecheck, lint, all 44 Bun tests, and iOS JavaScript export passed on Windows.
- KeyboardSessionCheck, SpeechWorkCheck, KeyboardBridgeCheck, ParakeetConfigurationCheck, and GoogleJwtCheck passed on the cloud Mac.
- The native iPhone Release archive succeeded with EAS build [739b68cd-d91a-49f0-ba7c-caaaf7033657](https://expo.dev/accounts/parthashirolkar/projects/shuddhalekhan-mobile/builds/739b68cd-d91a-49f0-ba7c-caaaf7033657), iOS build number 10.
- No phone results have been collected for this build. Background execution, interruptions, repeated utterances, model-switch memory, Dynamic Type, and touch feel remain device checks.

## Findings

### P2: Cancelled keyboard transcription keeps the speech engine occupied

`KeyboardSessionHost.swift:189` starts an unstructured transcription task without retaining its handle. Cancelling the request calls `discardUtterance`, and ending the session also discards it, but neither cancels this task. The request-ID check in `complete` correctly rejects its eventual result. It does not stop the work.

`ParakeetEngine.transcribe` keeps `inferenceInProgress` true until the outstanding inference returns. A user can cancel transcription in the keyboard, record another utterance, and stop it while the first inference is still running. The new transcription then fails with `SpeechError.busy`, shown as a generic transcription failure. The same can happen after stopping a keyboard session and starting in-app Dictation.

This violates write-swift sections 3 and 5: suspension permits intervening state changes, and unstructured task lifetimes and cancellation need an owner. Retain the request task, propagate cancellation through the native speech path where supported, and keep admission consistent until inference actually releases the engine. Calling `cancel()` alone is insufficient because cancellation is cooperative.

Regression to cover: suspend the first inference, cancel its keyboard request, and submit a second utterance before completing the first. Assert the intended admission and terminal states, including rejection of the first result. Verify on a phone that cancellation and subsequent dictation remain usable.

### P2: A previous listener startup timeout can stop a later startup

`KeyboardSessionServer.swift:56` launches a five-second task that accesses the shared `ready` continuation. It survives both successful readiness and `stop()`. If a session stops and another listener starts within those five seconds, the old task can consume the new listener's continuation and stop it if the new listener is still becoming ready. Listener callbacks also access `self.listener` and `self.ready` without checking that they belong to the listener that installed the callback.

This is the task-lifetime and exactly-once continuation contract in write-swift section 5. Associate callbacks and the timeout with their listener attempt. Retain and cancel the timeout on readiness and shutdown, and check cancellation or listener identity before mutating current state. The existing `try? await Task.sleep` would otherwise continue executing after cancellation.

Regression to cover: complete the first listener's startup, stop it, begin a second startup, then deliver the first attempt's timeout or failure. The second attempt must remain pending or succeed. Use controlled callbacks or a clock, rather than a sleep-based test.

### P2: Model switching can overlap an active inference with another encoder load

`ShuddhalekhanSpeechModule.swift:39` protects inference against other inference, but `loadManager` does not apply that admission rule to model replacement. At line 69 it drops the cached manager and loads another model. An outstanding `transcribe` call still retains its own manager across the inference await, so two encoders can remain resident despite the single-encoder comment.

This is reachable through settings while a keyboard session is active. Settings can be opened and saved while the in-app controller is idle; it does not own keyboard inference. Changing between English and another language triggers model preparation. The keyboard session retains its original language configuration. The overlap risks memory pressure, and later requests can force another model switch.

Write-swift sections 3 and 9 apply: actor isolation does not make an operation atomic across await, and memory claims need measurement. Reject or defer replacement of the resident model while inference holds it, and make settings behavior consistent with an active keyboard session. Preserve reuse of an existing load of the same model.

Regression to cover: pause English inference, request multilingual preparation, and assert that a second encoder cannot load until admission permits it. Measure peak resident memory on a phone when switching models during a keyboard session.

### P2: Temporary keyboard audio deletion failures are silently discarded

`KeyboardSessionHost.swift:192` and `:225` use `try?` when deleting completed or cancelled audio, then forget the URL. A deletion error leaves private audio in the app's temporary directory with no diagnostic or app-owned retry. The README promises deletion after transcription, while the in-app recorder already reports cleanup failure through the controller.

Write-swift section 2 calls for visible recoverable failures. Handle deletion failure without logging the audio, transcript, or private path, and retain a bounded way to retry cleanup. Distinguish transcription success from cleanup failure so a cleanup retry cannot replay text insertion.

Regression to cover: make file removal fail after completion and cancellation. Verify that cleanup failure remains observable or retryable and that neither path inserts a transcript again.

## Practices already followed

- Protocol data and configuration use concrete structs and enums with immutable fields and explicit Sendable conformance.
- UI, listener, and channel state use the main actor. Network callbacks are started on the main queue before using `MainActor.assumeIsolated`.
- The speech actor deduplicates concurrent loads of the same model and guards overlapping inference.
- The audio sink's unchecked sendability has an actual lock protecting its mutable state. Its synchronous critical sections contain no await.
- Protocol decoding bounds messages, validates command timestamps and IDs, authenticates the loopback connection, and correlates terminal text with the pending request before insertion.
- Production diagnostics use Logger and avoid audio, transcripts, credentials, and endpoint details. Callback closures generally break owner cycles with weak captures.
- The native checks exercise protocol transitions, authentication, transport, large final transcripts, disconnect cancellation, language routing, and an actual RSA signature against OpenSSL.

## Toolchain and follow-up checks

The speech pod requests Swift 6 language mode and the build script requires Xcode 26.4 or newer. These declarations do not establish the actual cloud compiler version or generated target settings. Repository settings do not explicitly enable Approachable Concurrency or default main-actor isolation. Inspect the generated targets before adopting the skill's newer syntax or changing isolation defaults.

In particular, caller-actor execution of nonisolated async functions depends on the `NonisolatedNonsendingByDefault` feature, rather than the compiler version alone. See the [Swift diagnostic documentation](https://docs.swift.org/latest/documentation/diagnostics/nonisolated-nonsending-by-default/) and [Swift migration guidance](https://www.swift.org/migration/documentation/swift-6-concurrency-migration-guide/featuremigration/). Keep compiler migration separate from behavioral fixes, as write-swift section 16 recommends.

`ShuddhalekhanSpeechModule` declares unchecked Sendable while inheriting Expo's Module. Its own mutable session field is main-actor isolated and its engine is an actor. Audit the inherited Expo behavior against the installed SDK before changing that conformance; its presence alone does not prove a race.

The standalone native checks use preconditions rather than Swift Testing. They run as small executables from the build script. Do not replace this working setup solely for syntax. Adopt Swift Testing when adding a native test target that can run these behavioral regressions without UIKit or FluidAudio test-only production hooks.

The audio tap writes to AVAudioFile while holding NSLock. That is a real-time performance measurement target, not evidence of a measured regression. Profile audio deadlines, lock contention, and file writes before adding a buffering queue. Check the keyboard's fixed height and unscaled character-key fonts with accessibility text sizes and landscape on a phone.

## Coverage and limits

Read all 14 committed Swift files: seven speech-module files, three keyboard-extension files, and four native-check files. Both copies of KeyboardSessionProtocol.swift have identical SHA-256 hashes; both copies of KeyboardSessionChannel.swift also match. Reviewed the JavaScript callers and native build configuration to establish reachable behavior.

No Swift compiler or Apple SDK is installed in this Windows environment. Instruments, background execution, microphone interruptions, and phone accessibility layout have not been exercised here. Findings describe source-supported failure paths; their timing and device impact have not been reproduced on hardware. The fixes require a new Release IPA and verification of its installed build number before interpreting phone results.
