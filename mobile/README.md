# Shuddhalekhan mobile

`mobile/` is a React Native app using Expo SDK 58 for iOS 17+. It records while open, transcribes with on-device Parakeet or a configured endpoint, and includes a keyboard that dictates into other apps during a keyboard session you start. Agent Mode sends a one-off command and asks before every tool call.

## Supported services

- Transcription providers matching the desktop: OpenAI, Sarvam AI, Azure Speech, Google Cloud Speech v2, NVIDIA Speech NIM, a whisper.cpp server, WhisperLiveKit, and custom OpenAI-compatible endpoints.
- Agent Mode providers matching the desktop: OpenAI and Azure OpenAI (Responses or Chat Completions), OpenRouter, and custom OpenAI-compatible Chat Completions endpoints, with reasoning-effort and prompt-caching options.
- Streamable HTTP MCP servers with bearer tokens.
- API keys saved with Expo SecureStore in the iOS Keychain.
- On-device Parakeet TDT v2 (English) and v3 (multilingual) INT8 through FluidAudio/Core ML.

Mobile settings are separate from the Electron desktop settings. The app does not import the desktop config or desktop model files. Existing saved settings keep the endpoint source after upgrading; their endpoints move to the custom OpenAI-compatible provider.

Google Cloud Speech v2 takes a service-account JSON key, stored in the Keychain. The app signs the token request on the phone and only sends it to `oauth2.googleapis.com`; the key's own `token_uri` is ignored. Recognition goes to the regional host for the chosen location. Remote providers receive the selected language in their own format (for example `en-IN` for Azure, Sarvam and Google). Choose your actual language and region rather than Auto-detect when a provider misidentifies it.

Sarvam recording stops automatically after 28 seconds, leaving two seconds for timer and recorder latency before its 30-second limit. Model downloads wait until launch-time preparation finishes. Older on-device settings with an unsupported endpoint language upgrade to Auto-detect without clearing credentials or MCP servers.

## Use Parakeet on this iPhone

In Settings, select **Transcription → On this iPhone**, choose a language, confirm **Download model**, and keep the app open through download and preparation. Each model is about 0.5 GB; Core ML also needs storage for its prepared models. Save the source selection, then record a short dictation. After setup, test it in airplane mode with Dictation selected. Agent Mode still sends the resulting text to its configured model endpoint.

The language decides the model. Any English variant, including English (India), uses the English-only Parakeet v2. Another supported language uses Parakeet v3 with that language as a script hint, one chunk at a time, without mel chunk context, as FluidAudio recommends for multilingual audio. Auto-detect uses v3 with no hint and can pick the wrong language or script. Only one model stays loaded; switching language may need the other download. NVIDIA reports an English average WER of 6.05% for v2 against 6.34% for v3, and FluidAudio reports LibriSpeech 2.1% against 2.5%. Accuracy on Indian-accented English has not been measured, so whether v2 fixes Cyrillic or Slavic-language output is unknown.

FluidAudio is pinned to v0.15.5 with INT8 encoders. The encoder uses CPU plus Apple Neural Engine; preprocessing also uses CPU. This is the Core ML export, not the desktop ONNX or Docker GGML files. Parakeet v3 supports 25 European languages. Neither model supports Hindi or Marathi, and the remote dictionary fields do not configure local inference.

When on-device transcription is selected and the model is installed, the app starts preparing it on launch without opening the microphone or downloading anything. Home shows a preparation notice while this runs. A session started during preparation awaits the same native load. First use after an update can still require Core ML preparation; moving that work before the session tap does not shorten compilation. Endpoint-only launches do not preload the local model. See the [startup measurements](docs/performance/2026-10-26-startup.md) for measured cases and pending device checks.

## Dictate in another app with the keyboard

iOS does not let keyboards use the microphone or open their app. So the app records during a **keyboard session** that you start, and the keyboard tells it when to start and stop.

1. Install the IPA with its keyboard extension retained.
2. On the phone, open **Settings → General → Keyboard → Keyboards → Add New Keyboard → Shuddhalekhan**. Tap that keyboard and enable **Allow Full Access**. The keyboard uses it only to exchange start, stop, and the finished text with the app. The keyboard connects only to the app on this iPhone and cannot use the microphone.
3. Download Parakeet for your language. On Home, tap **Start keyboard session**. The session lasts 10 minutes. Home shows a countdown and a **Stop session** button, and iOS shows its recording indicator.
4. In Notes or another app, switch to the Shuddhalekhan keyboard with the globe key. Tap **Dictate**, speak, then tap **Stop and insert**. The app transcribes the audio with Parakeet on the phone, and the keyboard types the text at the cursor. The **×** button cancels an utterance.

What happens to audio and text during a session:

- The microphone stays open for the whole session. Audio is written to a temporary file only between Dictate and Stop. That file is deleted after transcription. Failed deletion is logged without private paths and retried before another recording; new audio is blocked until cleanup succeeds. Audio left by an earlier process is cleaned up when the native session host starts. One utterance can last up to two minutes.
- When the timer runs out, the app finishes any utterance already started, then releases the microphone. The session also ends visibly on a call, Siri, a microphone change, or an iOS audio reset. The keyboard shows the reason.
- Music pauses while a session runs. Recording in the app itself is disabled until the session stops.
- Sessions use on-device Parakeet only. Remote transcription and Agent Mode still work from the Home record button.

Cancelling an utterance discards its result and requests native cancellation. If an inference step cannot stop immediately, subsequent transcription and model preparation wait for it to release the engine. Changing languages cannot load a second encoder during inference.

How the app and the keyboard talk: while starting in the foreground, the app publishes a random loopback port and a fresh 256-bit session secret in a team-scoped named pasteboard. The visible keyboard reads this once and authenticates a TCP connection to `127.0.0.1`. All recording commands, acknowledgements, and transcripts travel over that connection. The app never accesses the pasteboard in the background. The listener is inaccessible from the LAN and shuts down with the microphone session. This needs no App Group entitlement. The general clipboard is never read or written. Each utterance has a request ID; results are inserted once, only for the request this keyboard started. Closing the keyboard cancels its request. The cloud build runs both the native protocol check and an actual loopback transport check covering authentication, start/stop, a large final transcript, and disconnect cancellation.

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

Windows can run the mobile checks and upload the project to Expo EAS Build. Expo's cloud Mac compiles the IPA; no local Xcode, Bash, or GitHub push is needed.

For a small logic change, run the relevant test file from `mobile/`, for example `bun test src/__tests__/controller.test.ts`. The native Swift checks run as part of the cloud Mac build. Neither those checks nor a successful JavaScript export verifies background execution on an iPhone.

### Release build and phone reproduction

1. For Swift, native module, or keyboard changes, [build a new unsigned Release IPA](#build-an-ipa-from-windows-with-expo). Record its EAS build ID and iOS build number. Native changes require an IPA; Metro and JavaScript updates cannot replace the native module or keyboard extension.
2. From `mobile/`, run `npx --yes eas-cli@latest build:list --platform ios --limit 1 --json --non-interactive`. After the intended build is `FINISHED`, share its `artifacts.applicationArchiveUrl` or `artifacts.buildUrl` with the maintainer. Check the ID matches the build being tested rather than an older successful build.
3. Install the IPA through iLoader or Sideloadly using the same Apple ID, preserving the keyboard extension and existing app data. Confirm the installed build number with USB app metadata before debugging. Sideloading can rewrite the bundle identifier with a signing-team suffix.
4. Start the USB capture below, then ask the maintainer to reproduce on the phone and report when finished and what appeared. Record timestamps and screenshots. Stop the capture by its tracked PID after the attempt.
5. For keyboard dictation, download Parakeet, enable the keyboard and Full Access, start a session in the foreground app, switch to Notes, Dictate, speak, and Stop and insert. Confirm recording acknowledgement, transcription, and exactly one insertion at the cursor while the app is backgrounded. Try another utterance without restarting the session, then another host app. Report session loss separately from transcription success.

On October 26, 2026, the maintainer installed build 2 with iLoader and confirmed background recording, on-device transcription, and insertion in Notes. Repeated utterances, session persistence, expiry, and interruptions still need their own checks. Use the [device checks](#device-checks) for changes affecting those behaviors. Test ordinary in-app Dictation independently; include Agent Mode when changing its code.

Build 8 adds the desktop transcription and agent providers and English routing to Parakeet v2. None of it has been tested on a phone yet. Check v2 and v3 downloads, a language switch between them, the keyboard with each model, and each remote provider you use. Recognition on Google, Azure and Sarvam has only been tested against local stand-in servers.

Build 10 fixes cancellation and speech-operation admission, listener startup lifetime, and temporary keyboard audio cleanup, and improves the mobile sheets, touch feedback, and warnings. The Release archive and native regression checks passed on EAS build `739b68cd-d91a-49f0-ba7c-caaaf7033657`. This build has not been tested on a phone. Check cancel-then-dictate, stopping and restarting a session, model switching during a keyboard session, reduced motion, and larger text after installing it.

Build 11 retries a failed startup scan before admitting keyboard audio. Its new controlled listener check delivers a stale callback during replacement startup. EAS build `a825ca0f-de7b-4be9-bf12-706cc561454e` passed all six native checks and the Release archive. Both new regressions were verified to fail against the historical broken source and pass after the fixes. Phone validation remains pending.

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
  '--insensitive-regex', '"Shuddhalekhan|KeyboardBridge|Parakeet|AsrManager|pasteboard"')
$capture = Start-Process -FilePath $iosPython -ArgumentList $captureArgs -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput "$PWD/.cache/ios-device-live.log" `
  -RedirectStandardError "$PWD/.cache/ios-device-live.err"
$capture.Id
```

Keep the capture running while the maintainer reproduces. Inspect the error file if no events arrive. In the same PowerShell session, stop it after the attempt and inspect the relevant events:

```powershell
Stop-Process -Id $capture.Id
rg -n 'KeyboardBridge|AsrManager|not foreground|PBErrorDomain' .cache/ios-device-live.log
```

The keyboard path should show listener readiness, keyboard authentication, a start command, recording, stop, transcribing, and done. Check that text actually appears on the phone; logs alone do not prove insertion. Log phases and IDs without tokens, audio, transcripts, credentials, or private endpoint details. Keep raw captures local and redact excerpts before sharing them.

The countdown proves only that a microphone session was published. The original transport failed because iOS denied background pasteboard reads. Commands and results now use authenticated loopback TCP, with foreground pasteboard access only for initial discovery. Distinguish discovery/connection failure from recording or inference failure using the phase logs.

If historical logs are needed, use `pymobiledevice3 syslog collect` separately from live capture. Collection can terminate the live stream, so restart capture before another reproduction. A collected archive may require macOS Console to decode; do not infer events from unreadable Windows parser output.

## Build an IPA from Windows with Expo

From PowerShell in the repository root:

```powershell
bun install --frozen-lockfile --ignore-scripts
cd mobile
npx --yes eas-cli@latest login
npx --yes eas-cli@latest build --platform ios --profile sideloadly
```

Skip `login` if `npx --yes eas-cli@latest whoami` already shows your Expo account. The project is linked to `@parthashirolkar/shuddhalekhan-mobile`. A fork using another Expo account should run `npx --yes eas-cli@latest init` to link its own project first.

The command uploads your current local files, including uncommitted mobile changes, to Expo and prints a build page URL. After it finishes, open that page and select **Download** to save the unsigned `.ipa` on Windows. Open that IPA in iLoader or Sideloadly to sign and install it, retaining the keyboard extension. This Release build includes its JavaScript bundle and runs without Metro.

The `sideloadly` profile uses a custom EAS build with `withoutCredentials: true`. It creates a physical iPhone build, skips Apple signing on Expo, and uploads the IPA as the application archive. No Apple Developer membership or Apple credentials are needed for this build. Your Expo account's build quota applies. The Bash build script runs only on Expo's cloud Mac.

References: [EAS custom builds](https://docs.expo.dev/custom-builds/get-started/), [withoutCredentials](https://docs.expo.dev/eas/json/), [monorepo setup](https://docs.expo.dev/build-reference/build-with-monorepos/).

## Alternative builds on GitHub or a Mac

In GitHub Actions, open **Mobile iOS** and select **Run workflow**. The workflow runs the mobile checks, then uses `macos-latest` to generate the iOS project, install CocoaPods, and build a Release app with code signing disabled. The script requires Xcode 26.4 or newer. It packages the app as:

```text
mobile/build/ipa/Shuddhalekhan-unsigned.ipa
```

Download the `Shuddhalekhan-unsigned-ipa` artifact from that workflow run. The PR and `main` push checks run on Ubuntu and do not use macOS minutes. The manual build needs no Expo account or paid Apple Developer membership. GitHub Actions usage may count against the repository's GitHub plan.

The workflow verifies the unsigned app archive and IPA contents. It does not sign or install the app. Test the downloaded IPA with Sideloadly on the target iPhone before relying on the signing path.

The build script can also run on a Mac with Xcode, CocoaPods, Bun, and Node 24 installed:

```sh
bash mobile/scripts/build-ios.sh
```

The script runs the native keyboard-session self-check and checks the app bundle identifier, embedded JavaScript, permissions, and embedded keyboard before packaging the IPA. The IPA is unsigned and cannot install until iLoader or Sideloadly signs it.

## Install with Sideloadly

1. Download the IPA artifact and connect the iPhone to the Windows PC.
2. Open Sideloadly, select the IPA, sign in with an Apple ID, and install it.
3. Enable iOS Developer Mode if the device asks for it.

A free Apple ID signature expires after seven days. Keep Sideloadly's auto-refresh enabled. SecureStore items are tied to the signing team, so use the same Apple ID when refreshing or reinstalling if you want saved API keys to remain accessible. Signing with another team may require entering the keys again.

If saved settings or keys cannot be read, the app keeps them intact and blocks recording. Reopen the app first. The explicit **Reset saved settings** action clears the saved configuration so you can enter your endpoints and keys again.

## Device checks

- Save provider URLs and keys, close the app, reopen it, and confirm the settings remain.
- Record a dictation, stop, then copy and share the transcript into another app.
- Enable Agent Mode, run a command, approve one tool call, then deny another.
- Cancel an agent run while it waits for the model or a tool approval. Cancellation stops the app's request; an MCP server may already have completed an accepted operation.
- Without a keyboard session, record, background the app, and lock the device. In-app recording should stop when the app leaves the foreground.
- Install a refreshed IPA using the same Apple ID and confirm SecureStore can still read saved keys.
- Download Parakeet, restart the app, select On this iPhone, then transcribe a short recording in airplane mode. Measure cold load, repeated transcription time and memory on the tested phone before making performance claims.
- Add the keyboard and enable Full Access. Start a keyboard session, switch to Notes, then Dictate and Stop. Confirm the text is inserted once, with no paste prompt. Then check these cases: Dictate with no session ("Open Shuddhalekhan…"), cancel with ×, hide the keyboard mid-utterance, let the session expire mid-utterance, start a call during a session, and use a second app after inserting in the first.
- During a session, leave the app in the background for the full 10 minutes with Parakeet loaded. Confirm iOS does not kill it and that the recording indicator disappears when the session ends.
- Verify normal letters, shift, symbols, delete, return, and the globe menu in the custom keyboard. Check keyboard appearance with larger text and landscape.

## iOS limits

- iOS does not give the app a global hotkey or access to another app's focused text field. Use the keyboard during a session, or copy or share text.
- The custom keyboard cannot record or launch Shuddhalekhan. A keyboard session must be started in the app first; the keyboard says so if none is running.
- In-app recording stops when the app backgrounds or the device locks. Only a keyboard session keeps the microphone open in the background (the `audio` background mode), and only until its timer ends or you stop it.
- Keyboard commands and results use authenticated loopback TCP because iOS denies background pasteboard reads. Background recording, transcription, and insertion in Notes were confirmed on an iPhone with build 2; session persistence and interruption recovery need separate device checks.
- Recording is capped at five minutes. iOS records mono 16 kHz PCM WAV for Whisper compatibility. Temporary audio is deleted after completion or cancellation; transcripts and responses stay in memory until cleared or the app exits.
- Agent Mode supports Streamable HTTP MCP with bearer authentication. It does not support stdio MCP servers or OAuth.
- The agent uses non-streaming Chat Completions with live progress messages. It allows eight model steps and sixteen sequential, individually approved tool calls per command. Retrying a command may repeat earlier completed actions.
- HTTP endpoints require the explicit insecure HTTP setting. Prefer HTTPS. For a server on your Wi-Fi network, use an address the iPhone can reach; `localhost` points to the iPhone itself.
- The app does not import desktop shortcuts, provider settings, tool policies, or local model data.
