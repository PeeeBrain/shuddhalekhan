# Shuddhalekhan mobile

`mobile/` is a React Native app using Expo SDK 58 for iOS 17+. It records while open, transcribes with on-device Parakeet or a configured endpoint, and includes a full typing keyboard that also dictates into other apps during a keyboard session you start. Agent Mode sends a one-off command and asks before tool calls unless you explicitly allow them in Settings. Recording another Agent command while the answer is shown replies to it, and the answer card shows the conversation with your commands as chat bubbles. Tap the steps line above an answer to see what the agent said and which tools it called on the way.

## Supported services

- Transcription providers matching the desktop: OpenAI, Sarvam AI, Azure Speech, Google Cloud Speech v2, NVIDIA Speech NIM, a whisper.cpp server, WhisperLiveKit, and custom OpenAI-compatible endpoints.
- Agent Mode providers matching the desktop: OpenAI and Azure OpenAI (Responses or Chat Completions), OpenRouter, and custom OpenAI-compatible Chat Completions endpoints, with reasoning-effort and prompt-caching options.
- Streamable HTTP MCP servers with bearer tokens.
- API keys saved with Expo SecureStore in the iOS Keychain.
- On-device Parakeet TDT v2 (English) and v3 (multilingual) INT8 through FluidAudio/Core ML.

Mobile settings are separate from the Electron desktop settings. The app does not import the desktop config or desktop model files. Existing saved settings keep the endpoint source after upgrading; their endpoints move to the custom OpenAI-compatible provider.

Google Cloud Speech v2 takes a service-account JSON key, stored in the Keychain. The app signs the token request on the phone and only sends it to `oauth2.googleapis.com`; the key's own `token_uri` is ignored. Recognition goes to the regional host for the chosen location. Remote providers receive the selected language in their own format (for example `en-IN` for Azure, Sarvam and Google). Choose your actual language and region rather than Auto-detect when a provider misidentifies it.

Sarvam recording stops automatically after 28 seconds, leaving two seconds for timer and recorder latency before its 30-second limit. Model downloads wait until launch-time preparation finishes. Older on-device settings with an unsupported endpoint language upgrade to Auto-detect without clearing credentials or MCP servers.

## Recording sounds

On iOS, **Settings → Recording Sounds** controls the short Start, Stop and Error tones for in-app and keyboard-session Dictation and Agent Mode. It defaults to on, saves immediately on this device, and is independent of desktop Settings. **Preview Sound** plays the Start tone while the app is open and no recording or keyboard session is active. Preview uses output only. Agent setup, tool and response errors have no recording sounds.

Wait for **Listening** on the keyboard or **Recording** in the app before speaking. Start plays after microphone preparation and before the app writes speech audio. Stop plays after the app closes the audio file. Failed recording or transcription can play Error. Cancellation, expiry and interruptions drop pending sounds. If the keyboard session expires during Starting, it asks you to start a new session.

Recording tones use the active iOS recording route, using the speaker when no headset is routed, and can play in Silent Mode. Preview and errors outside an active audio session respect Silent Mode and can mix with existing media. The keyboard session keeps its existing nonmixing media policy. It enables output for cues and releases both input and output when it ends. Keyboard-session sounds can use a Bluetooth stereo output while capture keeps its usual microphone routes.

## Use Parakeet on this iPhone

In Settings, select **Transcription → On this iPhone**, choose a language, confirm **Download model**, and keep the app open through download and preparation. Each model is about 0.5 GB; Core ML also needs storage for its prepared models. Save the source selection, then record a short dictation. After setup, test it in airplane mode with Dictation selected. Agent Mode still sends the resulting text to its configured model endpoint.

The language decides the model. Any English variant, including English (India), uses the English-only Parakeet v2. Another supported language uses Parakeet v3 with that language as a script hint, one chunk at a time, without mel chunk context, as FluidAudio recommends for multilingual audio. Auto-detect uses v3 with no hint and can pick the wrong language or script. Only one model stays loaded; switching language may need the other download. NVIDIA reports an English average WER of 6.05% for v2 against 6.34% for v3, and FluidAudio reports LibriSpeech 2.1% against 2.5%. Accuracy on Indian-accented English has not been measured, so whether v2 fixes Cyrillic or Slavic-language output is unknown.

FluidAudio is pinned to v0.15.5 with INT8 encoders. The encoder uses CPU plus Apple Neural Engine; preprocessing also uses CPU. This is the Core ML export, not the desktop ONNX or Docker GGML files. Parakeet v3 supports 25 European languages. Neither model supports Hindi or Marathi, and the remote dictionary fields do not configure local inference.

When on-device transcription is selected and the model is installed, the app starts preparing it on launch without opening the microphone or downloading anything. Home shows a preparation notice while this runs. A session started during preparation awaits the same native load. First use after an update can still require Core ML preparation; moving that work before the session tap does not shorten compilation. Endpoint-only launches do not preload the local model.

## Dictation text

Choose **Polished**, **Casual**, **Notes**, or **Verbatim** in the iOS Transcription settings. Fresh installs use Polished. Existing installs keep their previous transcript behavior until a style is chosen. In a keyboard session, slide from the Dictation key to pick a style between utterances (VoiceOver: the key's Dictation styles action). Dictation snapshots the style and optional vocabulary at the start of each utterance.

**Vocabulary** restores preferred spellings after speech recognition, on the device. It accepts up to 100 distinct terms of 64 characters. The remote endpoint's Dictionary setting still provides recognition hints and may be sent to the configured endpoint. Names and terms from the new Vocabulary list stay on the phone. Agent Mode uses the recognizer's original transcript.

The keyboard adds spacing where it can read the cursor context. After an insertion the host confirms, **Undo** shows in the suggestion strip for up to 12 seconds. The next edit, a change of field, or moving the cursor dismisses it.

**Clean Up with Apple Intelligence** is off by default. It uses the on-device model on eligible iOS 26+ devices when the model and language are available. If it times out or proposes a change the app cannot verify, Dictation continues with the text it already has.

## System shortcuts and controls

On iOS 18+, **Dictate**, **Start Keyboard Session**, and **Stop Keyboard Session** are available in Shortcuts. Add the Dictate shortcut to the Action Button or Back Tap through iOS Settings. Dictation started directly from Shortcuts requires a local Parakeet model, microphone permission, and Live Activities. If iOS refuses capture from the current screen, open Shuddhalekhan and use Dictate there. Starting a keyboard session from Shortcuts opens the app for setup and starts a Dictation-only session. Start from Home to use Ask Agent.

Run Dictate again or tap **Stop** in the recording Live Activity to finish. **Cancel** discards it. If the app is active, a successful result copies to the local clipboard. Otherwise open Home and use the result's Copy action. The **Shuddhalekhan Dictation** control in Control Center opens the app and starts local Dictation on Home. Tap **Stop** there and use **Copy** on the result. If a keyboard session is running, end it before tapping the control. Test phone lock, background starts, control registration, and the clipboard flow on the sideloaded build before relying on them.

## Dictate in another app with the keyboard

iOS does not let keyboards use the microphone. So the app records during a **keyboard session**, and the keyboard tells it when to start and stop. If the keyboard reports no session, open Shuddhalekhan and start one, then switch back and tap the microphone key at the right end of the suggestion strip to dictate, or the agent key at the left end to ask the agent.

The keyboard is a full typing keyboard adapted from [Hex](https://github.com/anomalyco/hex)'s iPhone keyboard (MIT, see `targets/transcript-keyboard/Typing/NOTICE.md`; only the keyboard comes from Hex): suggestions, autocorrect, swipe typing, emoji, long-press accents, and trackpad and two-thumb selection. Typing needs neither a session nor Full Access. Its layout follows the iPhone's keyboard languages, but only the English typing model ships, and it has no settings of its own. Tap a voice key to start and tap ✓ to stop, or hold the key and let go to stop; ✕ cancels. On a docked iPad the microphone key sits on the bottom row, as Apple's does, and there is no agent key.

1. Install the IPA with its keyboard extension retained.
2. On the phone, open **Settings → General → Keyboard → Keyboards → Add New Keyboard → Shuddhalekhan**. Tap that keyboard and enable **Allow Full Access**. The keyboard needs it to exchange start, stop, and the finished text with the app, and for key haptics and the Paste chip. The keyboard connects only to the app on this iPhone and cannot use the microphone.
3. Download Parakeet for your language. On Home, tap **Start keyboard session**. A session lasts 10 minutes by default. In **Settings → Keyboard** you can choose 5, 10, 15, or 30 minutes for the next session. Home shows a countdown and a **Stop** button, and iOS shows its recording indicator. Recording on Home ends the session first, since the session holds the microphone.
4. In Notes or another app, switch to the Shuddhalekhan keyboard with the globe key. Tap the microphone key, speak, then tap ✓. The app transcribes with Parakeet on the phone and inserts the text at the cursor. Or tap the agent key to speak a one-off command. Agent transcripts never type into the host app. ✕ discards either kind of recording; the dots in the strip follow the microphone while recording.

What happens to audio and text during a session:

- The microphone stays open for the whole session. Audio is written to a temporary file only between Dictate and Stop. That file is deleted after transcription. Failed deletion is logged without private paths and retried before another recording; new audio is blocked until cleanup succeeds. Audio left by an earlier process is cleaned up when the native session host starts. One utterance can last up to two minutes.
- When the timer runs out, the app finishes any utterance already started, then releases the microphone. The session also ends visibly on a call, Siri, a microphone change, or an iOS audio reset. The keyboard shows the reason.
- Music pauses while a session runs. Recording in the app itself is disabled until the session stops.
- Sessions use on-device Parakeet only. Remote transcription remains available from Home. The agent key works when Agent Mode and its credentials are configured at session start. A busy agent or a failed handoff shows an error in the keyboard; "Sent to the agent" means the controller admitted the run.
- Keyboard commands use the same agent, tool approvals, saved result, and notification path as Home. Allow notifications when starting the session. iOS cannot create a Live Activity or request continued processing from the background, so the app creates a keyboard-session Live Activity while it is still open. It shows the session countdown, and each keyboard command takes it over to show status, approvals, and the answer. It ends with the session, or with the last command still running when the session ends. Background-started runs use the open microphone session for execution time. Live Activity updates request a separate, short UIKit background grant because audio execution alone cannot publish them. If iOS declines an update, reopening the app refreshes the adopted activity from the latest run state. If that session ends while the run is backgrounded without another execution grant, the run stops visibly. Open the app to review or approve tools. Starting a new session refreshes Agent Mode availability after settings changes.

Cancelling an utterance discards its result and requests native cancellation. If an inference step cannot stop immediately, subsequent transcription and model preparation wait for it to release the engine. Changing languages cannot load a second encoder during inference.

Verify keyboard Agent Mode in a new Release IPA with the containing app backgrounded: speak a command, stop, and confirm the provider receives it and a result notification arrives. Try a second command while one is running, cancel during transcription, and expire or stop the session during a slow run. The keyboard must report busy/cancel/failure accurately, never insert an agent prompt, and keep Dictation working afterward. Automated controller tests cover handoff and single-flight behavior; actual background JS execution, microphone levels, approval delivery, and interruption notifications still need a phone.

How the app and the keyboard talk: while starting in the foreground, the app publishes a random loopback port and a fresh 256-bit session secret in a team-scoped named pasteboard. The visible keyboard reads this once and authenticates a TCP connection to `127.0.0.1`. All recording commands, acknowledgements, transcripts, and microphone levels travel over that connection. Levels are sampled at most 15 times per second and never sent to JavaScript. The app never accesses the pasteboard in the background. The listener is inaccessible from the LAN and shuts down with the microphone session. This needs no App Group entitlement. The session never uses the general clipboard. Like the system keyboard, the typing keyboard reads it only when you tap Paste and writes it only for Cut and Copy. Each utterance has a request ID and mode; Dictation results are inserted once, only for the request this keyboard started. Closing the keyboard cancels its request. The cloud build runs both the native protocol check and an actual loopback transport check covering authentication, start/stop, a large final transcript, and disconnect cancellation.

Secure fields and apps that disallow third-party keyboards use the system keyboard instead.

## Test Agent Mode with LM Studio over Tailscale

1. Load a chat model in LM Studio and start its server. Under **Developer → Server Settings**, enable **Serve on Local Network**. The default server port is `1234`.
2. On the desktop, run `tailscale ip -4`. With Tailscale connected on the phone, open `http://DESKTOP_TAILSCALE_IP:1234/v1/models` in Safari. If it cannot connect, fix the server binding, Tailscale permissions, or Windows firewall before testing the app.
3. In Shuddhalekhan Settings, enable Agent Mode. Choose **Custom OpenAI-compatible**, set **Endpoint** to `http://DESKTOP_TAILSCALE_IP:1234/v1/chat/completions`, **Model** to the exact loaded identifier returned by `/v1/models`, and leave the key blank unless LM Studio authentication is enabled. For an authenticated server, enter its token.
4. Enable **Allow unencrypted HTTP** for an `http://` endpoint, save, select Agent on Home, and record a command. Tailscale encrypts traffic between its devices even though the application URL uses HTTP.

Start with no MCP servers and a simple question. To test tools, add reachable HTTP MCP endpoints to the app and use a model with tool support. The mobile app discovers and executes those tools with individual approvals; LM Studio's desktop chat configuration and MCP connections are not imported.

References: [LM Studio network setup](https://lmstudio.ai/docs/developer/core/server/serve-on-network), [tool calls](https://lmstudio.ai/docs/developer/openai-compat/tools).

The monorepo uses Bun's hoisted linker and a shared React 19.3 version to keep native modules deduplicated. Keep the committed root `bunfig.toml` when installing or building.

## Verification

### Native contracts

Edit `KeyboardSessionProtocol.swift` and `KeyboardSessionChannel.swift` in `modules/shuddhalekhan-speech/ios/`, and `AgentActivityAttributes.swift` in `modules/shuddhalekhan-agent-activity/ios/`. The `with-shared-native-contracts` Expo plugin copies them into the extension targets before Xcode project generation; those copies are ignored and missing inputs fail prebuild. Run prebuild after editing a contract if building directly in Xcode.

### Phone pass

Verify the installed build number, device model, iOS version, and the artifact run and commit first. Record each case as pass, fail, or untested, with provider, entry point, and timestamp. Exercise only the cases the change touches.

1. **Settings retention.** Reopen saved settings, then save, force-close, and reopen. Switching providers clears the previous provider's secret; cancelling unsaved edits keeps saved settings.
2. **In-app Dictation.** With Agent Mode off, record, stop, and copy a transcript with each configured provider, and with Parakeet in airplane mode. Cancel an utterance; the next one works. Recording outside a keyboard session stops when backgrounded.
3. **Keyboard Dictation.** Follow the keyboard steps in AGENTS.md: text inserts exactly once while the app stays backgrounded, for a second utterance and in a second host app.
4. **Session exits.** Cancel, hide and reopen the keyboard mid-utterance, stop and restart the session, let it expire, and interrupt it (Siri or a call). The reason is visible, the microphone releases, and a new session works. With no session, Dictate tells you to open Shuddhalekhan. Start a session from Home, switch back to the keyboard, and confirm that Dictate inserts text at the cursor.
5. **Agent Mode.** From Home and the background keyboard: prompts never insert into the host app; approve one tool, deny another, cancel while waiting; a stale approval never executes; a second command while busy is refused; Dictation still works after. The Live Activity shows progress, approvals open the right request, and the answer survives a restart.
6. **Providers.** Exercise each provider you have credentials for and record the others as untested. Sarvam auto-stops around 28 seconds, Google around 55.
7. **Recording sounds.** With USB logging active, confirm one Start and one Stop for in-app Dictation and for keyboard Dictation in two host apps. Say distinct words immediately at the ready indicator and just before Stop, and confirm both appear with no added words from the tones. Repeat on the speaker, wired headphones and Bluetooth, and check Silent Mode. Connect and disconnect the Bluetooth headset during a live keyboard session. Confirm the app either keeps capturing on a valid input or clearly ends the session and lets you restart. Try a current capture failure, cancel during Starting, interrupt with a call and let a session expire. If it expires during Starting, the keyboard should keep showing the reason after the connection closes. Confirm mute persists across relaunch and silences both entry points. Preview must leave the microphone indicator off and produce no transcript or upload. Repeat the capture checks with Agent Mode and confirm tools and responses remain quiet. Filter on the `RecordingCues` log category alongside `KeyboardBridge` to correlate cues with capture transitions.

### Local checks on Windows

Install workspace dependencies from the repository root without running the Electron install hooks:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run --cwd mobile test
bun run --cwd mobile typecheck
bun run --cwd mobile lint
bun run --cwd mobile export:ios
```

Start Metro with `bun run --cwd mobile start`. A Release IPA does not connect to Metro. Use an SDK 58 compatible Expo Go or development client for live reload.

For a small logic change, run the relevant test file from `mobile/`, for example `bun test src/__tests__/controller.test.ts`. The native Swift checks run as part of the IPA build on Expo or GitHub Actions. Neither those checks nor a successful JavaScript export verifies background execution on an iPhone.

### Release build and phone reproduction

1. For Swift, native module, or keyboard changes, [build a new unsigned Release IPA](#build-an-ipa). Record its Expo build or GitHub workflow URL and iOS build number. Native changes require an IPA; Metro and OTA updates cannot replace the native module or keyboard extension.
2. After the intended run succeeds, share its build URL with the maintainer. Check it matches the build being tested rather than an older successful run.
3. Install the IPA through iLoader using the same Apple ID, preserving the keyboard extension and existing app data. Confirm the installed build number with USB app metadata before debugging; for a release IPA, also check that its version (`CFBundleShortVersionString`) matches the tag, since releases can share a build number. Sideloading can rewrite the bundle identifier with a signing-team suffix.
4. Start the USB capture below, then ask the maintainer to reproduce on the phone and report when finished and what appeared. Record timestamps and screenshots. Stop the capture by its tracked PID after the attempt.
5. For keyboard dictation, download Parakeet, enable the keyboard and Full Access, start a session in the foreground app, switch to Notes, Dictate, speak, and Stop and insert. Confirm recording acknowledgement, transcription, and exactly one insertion at the cursor while the app is backgrounded. Try another utterance without restarting the session, then another host app. Report session loss separately from transcription success.

On October 26, 2026, the maintainer installed build 2 with iLoader and confirmed background recording, on-device transcription, and insertion in Notes. Repeated utterances, session persistence, expiry, and interruptions still need their own checks. Use the [device checks](#device-checks) for changes affecting those behaviors. Test ordinary in-app Dictation independently; include Agent Mode when changing its code.

Build 8 adds the desktop transcription and agent providers and English routing to Parakeet v2. None of it has been tested on a phone yet. Check v2 and v3 downloads, a language switch between them, the keyboard with each model, and each remote provider you use. Recognition on Google, Azure and Sarvam has only been tested against local stand-in servers.

Build 10 fixes cancellation and speech-operation admission, listener startup lifetime, and temporary keyboard audio cleanup, and improves the mobile sheets, touch feedback, and warnings. The Release archive and native regression checks passed on EAS build `739b68cd-d91a-49f0-ba7c-caaaf7033657`. This build has not been tested on a phone. Check cancel-then-dictate, stopping and restarting a session, model switching during a keyboard session, reduced motion, and larger text after installing it.

Build 11 retries a failed startup scan before admitting keyboard audio. Its new controlled listener check delivers a stale callback during replacement startup. EAS build `a825ca0f-de7b-4be9-bf12-706cc561454e` passed all six native checks and the Release archive. Both new regressions were verified to fail against the historical broken source and pass after the fixes. Phone validation remains pending.

Build 12 added agent Live Activities and iOS 26 continued background processing; [GitHub's Mac build](https://github.com/PeeeBrain/shuddhalekhan/actions/runs/40545987344) compiled and packaged its Release IPA. Build 13 removes the duplicate custom card on iOS 26, adds actionable approval notifications, and renders final answers as Markdown. The 27 focused agent/controller tests, mobile typecheck/lint/export, Swift state/storage self-check, and Swift syntax parsing pass locally. Build 13's Release archive and device verification are pending. Local checks do not establish that React Native keeps executing on a locked phone.

### Agent Live Activity checks

Keep the app open through recording and transcription. Once Agent Mode starts, it requests iOS 26 continued processing. iOS can decline or end that request. On older iOS, or without a grant, backgrounding stops the run; the activity reports interruption. Dictation and the keyboard session keep their separate lifecycles.

iOS 26 shows only the system continued-processing activity, with generic model/tool stage updates and its Stop control. At completion its subtitle receives the first 160 characters of the answer, with an additional byte bound. iOS controls the visible length and how long the completed system activity remains. The system activity has no privacy-redaction API, so this preview can appear on the Lock Screen. Approvals and background results use local notifications. Allow notification alerts when the first agent run asks. Expand an approval notification to reveal **Approve once**, **Deny**, and **Review arguments**. Approve and Deny authenticate and open the app, then resolve the exact live, unexpired request without a second confirmation. Review opens the argument sheet without executing anything. If alerts are disabled or delivery fails, the sheet opens in the app instead; its pending request also has a Review button on Home. Focus and notification settings can still suppress alerts.

In Settings, open an MCP server's **Tool approval policies**, then **Discover tools**. Discovery lists tools without executing them. Choose **Ask every time**, **Always allow**, or **Disabled** per tool, then save Settings. Policies belong to that server and exact tool name. New tools and existing settings without policies ask every time. Always allow skips the approval sheet and notification; Disabled tools are withheld from the model and cannot execute. Changing an endpoint or bearer token clears that server's policies. Saved policies remain editable offline, and discovery never grants permission based on server-provided annotations.

An ordinary background task cannot create a replacement custom activity when a tool approval arrives, and the system activity cannot host app-defined approval buttons. This is why build 13 uses notifications rather than attempting to swap between two activities. See Apple's [Live Activity request constraints](https://developer.apple.com/documentation/activitykit/activity/request(attributes:content:pushtype:)) and [notification actions](https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types).

- Run a command with a slow model response, switch to Notes, then lock the phone. Confirm actual completion and the final answer, not just an unchanged activity. Check a run with a tool and a second run in the same process.
- While backgrounded, trigger a tool approval. Expand its notification and choose Review arguments; unlock and confirm it executes nothing. Repeat using Approve once directly from the notification, background again, and confirm the tool result and final answer. Repeat with Deny, a duplicate tap, and an old notification after a newer approval appears. Notification actions must authenticate; ordinary activity links never approve a tool.
- Deny notification permission, then repeat a tool run in the app. Confirm the fallback approval sheet remains usable. With permission granted, confirm a foreground notification and a compact Review card replace the automatically opened full-screen sheet.
- Discover tools, set one to Always allow and another to Disabled, save, and reopen Settings. Confirm the allowed tool runs without approval and the disabled tool never runs. A tool with the same name on another server must still ask. Change the endpoint or token and confirm its policies reset. Discovering a newly added tool must leave it asking every time.
- An approval wait releases continued processing. Approval expires after 15 minutes; returning then must stop the run without executing the pending tool. Opening the app to approve starts a new continued-processing request for the remaining work.
- Cancel through the app and through the system background-task view. Check a slow provider and an already-started tool. The run stops locally, but a remote tool may already have completed its action. Swiping away the custom activity only dismisses its display.
- Force-quit during a model request and an approval wait. Reopening must show interruption and must not replay a tool or a command. Complete another run, terminate, and confirm its saved final answer restores. Clear removes that saved answer and its activity.
- Check that iOS 26 has one running activity, its model/tool stage changes, and its completion subtitle contains the answer preview. Check clipping in the expanded Island and Lock Screen, and note when iOS dismisses the completed activity. The result notification also shows a bounded preview; opening the app shows the full answer with Markdown headings, emphasis, lists, code, and tables. Copy and Share retain the original Markdown. Images are not fetched and links permit only web/mail schemes. Test larger text and notification preview privacy settings.
- On iOS 17–25, check the custom Lock Screen and compact/expanded Dynamic Island activity, Live Activities disabled, and private-data redaction. Its final preview is at most 160 characters with an additional byte bound, and ends after five minutes. Prompts, tool arguments, tool results, keys, and endpoint URLs are excluded from activity and notification data. Tool/server names appear in approval notifications and follow the device's preview settings.
- Sideload the app with both the dictation keyboard and agent widget retained. Confirm installed build 14, then check ordinary in-app Dictation and keyboard insertion again.
- Inspect the installed bundle identifier and `BGTaskSchedulerPermittedIdentifiers` after re-signing. The `.agent.*` pattern must start with the installed bundle identifier. If the signer rewrites only the bundle identifier, update its Info.plist rewrite before signing; native logs `AgentActivity stage=task_identifier_mismatch` and keeps execution foreground-only until they match. This check remains pending installation.

One agent lifecycle record and the last final answer are stored in app-private, backup-excluded Application Support with iOS data protection. Starting a replacement recording or clearing results removes the previous result. The conversation an in-app Agent recording replies to is kept in memory only and ends when results are cleared, settings are saved, or the app quits; keyboard agent commands always start fresh, but their answer on Home can be replied to by recording there. There is no persisted prompt or automatic retry. Failed cleanup is reported. The app keeps the full live answer in memory; saved answers are bounded to 200,000 UTF-16 code units.

For performance changes, measure tap-to-session-ready and Stop-to-insertion separately. Compare a process-cold launch with a second session in the same process, recording permission prompts and model preparation separately. Record the device, iOS version, build number, and timings; one fast retry does not establish cold-start performance.

### USB logs from Windows

Connect the unlocked iPhone, accept Trust This Computer, and ensure the Apple Mobile Device USB drivers/service are installed. Run from the repository root in PowerShell 7. Reuse the ignored diagnostic virtual environment if present; otherwise create it once:

```powershell
py -m venv .cache/ios-device
.cache/ios-device/Scripts/python.exe -m pip install pymobiledevice3==11.44.0
```

Discover the phone and installed app without assuming that the IPA's original bundle identifier survived signing:

```powershell
$iosPython = (Resolve-Path .cache/ios-device/Scripts/python.exe).Path
& $iosPython -m pymobiledevice3 usbmux list
$installedApps = (& $iosPython -m pymobiledevice3 apps list --type User | Out-String | ConvertFrom-Json -AsHashtable)
$installedApps.GetEnumerator() | Where-Object Key -Like '*shuddhalekhan*' | ForEach-Object {
  [pscustomobject]$_.Value | Select-Object CFBundleIdentifier, CFBundleVersion, CFBundleShortVersionString, UIBackgroundModes
}
```

For more than one connected device, pass `--udid DEVICE_IDENTIFIER` to the app and syslog commands. Capture the app/keyboard phases and pasteboard failures to ignored files with a tracked PID:

```powershell
$captureArgs = @('-u', '-m', 'pymobiledevice3', 'syslog', 'live', '--label',
  '--insensitive-regex', '"Shuddhalekhan|KeyboardBridge|RecordingCues|Parakeet|AsrManager|pasteboard"')
$capture = Start-Process -FilePath $iosPython -ArgumentList $captureArgs -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput "$PWD/.cache/ios-device-live.log" `
  -RedirectStandardError "$PWD/.cache/ios-device-live.err"
$capture.Id
```

Keep the capture running while the maintainer reproduces. Inspect the error file if no events arrive. In the same PowerShell session, stop it after the attempt and inspect the relevant events:

```powershell
Stop-Process -Id $capture.Id
rg -n 'KeyboardBridge|RecordingCues|AsrManager|not foreground|PBErrorDomain' .cache/ios-device-live.log
```

The keyboard path should show listener readiness, keyboard authentication, a start command, recording, stop, transcribing, and done. Check that text actually appears on the phone; logs alone do not prove insertion. Log phases and IDs without tokens, audio, transcripts, credentials, or private endpoint details. Keep raw captures local and redact excerpts before sharing them.

The countdown proves only that a microphone session was published. The original transport failed because iOS denied background pasteboard reads. Commands and results now use authenticated loopback TCP, with foreground pasteboard access only for initial discovery. Distinguish discovery/connection failure from recording or inference failure using the phase logs.

If historical logs are needed, use `pymobiledevice3 syslog collect` separately from live capture. Collection can terminate the live stream, so restart capture before another reproduction. A collected archive may require macOS Console to decode; do not infer events from unreadable Windows parser output.

## Distribution

Installation and updates need no paid Apple Developer Program or paid Expo plan. Standard GitHub-hosted runners are free for this public repository. Native code ships as an unsigned IPA that each person signs with their own free Apple ID. JavaScript ships over the air with EAS Update.

| Change | How it reaches the phone |
| --- | --- |
| Swift, native module, keyboard or widget extension, native dependency, `app.json` | New IPA: [build](#build-an-ipa), then [install](#install-with-iloader) |
| JavaScript or assets only | [`eas update`](#ship-javascript-over-the-air) |

A `vX.Y.Z` release tag ships iOS with the desktop builds: `release.yml` prepares a draft and builds Windows, Linux, and the unsigned IPA in parallel on GitHub-hosted runners. After all three builds and the desktop checks succeed, it publishes the same commit as an OTA update on Linux using the resolved runtime version embedded in the IPA, including its bundled fingerprint, then publishes the GitHub release. That job needs an `EXPO_TOKEN` repository secret (an Expo access token); without it the release stays a draft. Between releases, use the manual workflow and `eas update` below. To recover a failed tag release after fixing CI, run **Release App** from `main` with the existing tag as its `tag` input. It builds the tagged product source with the selected workflow revision's iOS build helper, reuses the draft, and refuses to overwrite a published release. The tag stays unchanged. If all three platform builds passed and publication failed, set `resume-run-id` to that run ID to retry publication without rebuilding; the workflow verifies successful jobs, checkout commits, matching release notes, and asset upload times against that run, then reads the runtime from the attached IPA. Retain the run logs and artifacts for this verification. If OTA publication already succeeded, the retry only finalizes the release metadata.

## Build an IPA

To build on Expo without Apple credentials, run this from `mobile/` while signed in to the linked EAS project:

```sh
bunx eas-cli build --platform ios --profile sideload --non-interactive
```

Download the unsigned IPA from the EAS build page and [sign it with iLoader](#install-with-iloader). The sideload profile runs the same native self-checks and Release archive script as GitHub Actions.

In GitHub Actions, open **Mobile iOS** and select **Run workflow**. The workflow runs the mobile checks, then uses `macos-26` to generate the iOS project, install CocoaPods, run the native Swift self-checks, and build a Release app with code signing disabled. The script requires Xcode 26.4 or newer. Download the `Shuddhalekhan-unsigned-ipa` artifact from that run. The PR and `main` push checks run on GitHub-hosted `ubuntu-24.04` runners. Both runner types are standard GitHub-hosted runners, free for public repositories.

The same script runs on a Mac with Xcode, CocoaPods, Bun, and Node 24:

```sh
bash mobile/scripts/build-ios.sh
```

It checks the bundle identifier, embedded JavaScript, permissions, Live Activity configuration, and both extensions before packaging `mobile/build/ipa/Shuddhalekhan-unsigned.ipa`. The IPA is unsigned and cannot install until iLoader or Sideloadly signs it.

## Install with iLoader

1. Download the IPA artifact and connect the iPhone.
2. Open iLoader, sign in with your Apple ID, select the IPA, and install it with the keyboard and agent extensions retained.
3. Enable iOS Developer Mode if the device asks for it.

Sideloadly works the same way. A free Apple ID signature expires after seven days; re-sign before then. One install uses three of the Apple ID's ten weekly App IDs (app, keyboard, agent activity). SecureStore items are tied to the signing team, so use the same Apple ID when refreshing or reinstalling if you want saved API keys to remain accessible. Signing with another team may require entering the keys again. Sideloading can add a signing-team suffix to the bundle identifier; OTA updates do not depend on it.

## Ship JavaScript over the air

The app checks EAS Update's `production` channel on every launch, downloads a matching update in the background, and runs it on the next cold start. `runtimeVersion` uses the `fingerprint` policy, so an update reaches only installs whose native code matches the project that published it. After a native change, ship a new IPA first; older installs keep their last compatible update.

From `mobile/`, with the native code unchanged since the installed IPA:

```sh
npx --yes eas-cli@latest login
npx --yes eas-cli@latest update --platform ios --channel production --environment production --message "Describe the fix"
```

The project is linked to `@parthashirolkar/shuddhalekhan-mobile`. A fork first removes `owner`, `extra.eas.projectId`, and `updates.url` from `app.json`, runs `npx --yes eas-cli@latest init` and `eas update:configure`, and commits the result before building its first IPA; otherwise that IPA asks the original project for updates. EAS Update's free tier covers 1,000 monthly active users. Updates are not code-signed, which needs a paid plan, so keep two-factor login on the Expo account that publishes them.

To check a published update against an installed IPA, compare the runtime version `eas update` prints with `npx expo-updates fingerprint:generate --platform ios` run on the commit the IPA was built from.

If saved settings or keys cannot be read, the app keeps them intact and blocks recording. Reopen the app first. The explicit **Reset saved settings** action clears the saved configuration so you can enter your endpoints and keys again.

## Device checks

- Save provider URLs and keys, close the app, reopen it, and confirm the settings remain.
- Record a dictation, stop, then copy and share the transcript into another app.
- Enable Agent Mode, run a command, approve one tool call, then deny another.
- Cancel an agent run while it waits for the model or a tool approval. Cancellation stops the app's request; an MCP server may already have completed an accepted operation.
- Without a keyboard session, record, background the app, and lock the device. In-app recording should stop when the app leaves the foreground.
- Install a refreshed IPA using the same Apple ID and confirm SecureStore can still read saved keys.
- Publish a visible JavaScript change with `eas update`, cold-start the app twice, and confirm it appears. Re-sign with iLoader and confirm the update is still running.
- Download Parakeet, restart the app, select On this iPhone, then transcribe a short recording in airplane mode. Measure cold load, repeated transcription time and memory on the tested phone before making performance claims.
- Add the keyboard and enable Full Access. Start a keyboard session, switch to Notes, then Dictate and Stop. Confirm the text is inserted once, with no paste prompt. Then check these cases: Dictate with no session (the app opens and starts a session; return with ◀ and recording starts by itself), cancel with ×, hide the keyboard mid-utterance, let the session expire mid-utterance, start a call during a session, and use a second app after inserting in the first.
- During a session, leave the app in the background for the full 10 minutes with Parakeet loaded. Confirm iOS does not kill it and that the recording indicator disappears when the session ends.
- Verify normal letters, shift, symbols, delete, return, and the globe menu in the custom keyboard. Check keyboard appearance with larger text and landscape.

## iOS limits

- iOS does not give the app a global hotkey or access to another app's focused text field. Use the keyboard during a session, or copy or share text.
- The custom keyboard cannot record. Without a session it opens Shuddhalekhan to start one, which needs Full Access. iOS gives no public way back to the previous app, so you return with ◀ or a swipe.
- In-app recording stops when the app backgrounds or the device locks. Only a keyboard session keeps the microphone open in the background (the `audio` background mode), and only until its timer ends or you stop it.
- Keyboard commands and results use authenticated loopback TCP because iOS denies background pasteboard reads. Background recording, transcription, and insertion in Notes were confirmed on an iPhone with build 2; session persistence and interruption recovery need separate device checks.
- Recording is capped at five minutes. iOS records mono 16 kHz PCM WAV for Whisper compatibility. Temporary audio is deleted after completion or cancellation. Transcripts stay in memory; the last agent answer is also saved locally until cleared or replaced.
- Agent Mode supports Streamable HTTP MCP with bearer authentication. It does not support stdio MCP servers or OAuth.
- The agent runs on the AI SDK runtime shared with desktop (`packages/shared/src/agent-loop.ts`), streaming from the saved endpoint through `expo/fetch`. It allows 30 model steps per command, the last one tool-free, gated by each tool's saved approval policy. A denied tool is reported to the model, which explains or tries another way. Retrying a command may repeat earlier completed actions.
- iOS 26 uses the system activity for agent progress and notifications for approval actions and background results. Notification actions authenticate and foreground the app before approving or denying the exact pending request. Continued processing is best-effort and does not survive force quit. Earlier iOS versions retain the custom activity and require the app to remain foregrounded while working. Final answers render Markdown in the app; Copy and Share preserve the source text.
- HTTP endpoints require the explicit insecure HTTP setting. Prefer HTTPS. For a server on your Wi-Fi network, use an address the iPhone can reach; `localhost` points to the iPhone itself.
- The app does not import desktop shortcuts, provider settings, tool policies, or local model data.
