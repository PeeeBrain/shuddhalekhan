# Dictation

The user presses the Dictation shortcut configured in Settings. The blue recording pill appears, audio goes to the active speech engine, and the transcript is pasted into the window that was focused when recording started. `Paste last transcript` and `Copy last transcript` in the tray recover the last result.

## Sub-features

- `dictation-start-stop`: the shortcut shows the recording pill, and ending it (as the configured activation mode defines) stops recording and transcribes.
- `dictation-paste`: the transcript appears exactly once at the cursor of the original window, and the clipboard is restored.
- `dictation-cancel`: cancelling, suspending, or locking the screen ends the recording without pasting.
- `dictation-not-ready`: with no speech engine ready, the user sees an error instead of a silent no-op.
- `dictation-recover`: the tray's Paste/Copy last transcript.

## How to get to it (user POV)

- The global shortcut shown in Settings → `Shortcuts & Mic`, with its configured activation mode.
- Onboarding Step 3 (fresh config only).
- Tray menu: Paste/Copy last transcript, plus pausing shortcuts.

## Driving it with sl.ts

Preconditions:

- Launched on the real config.
- Read the speech engine with `bun $S config transcription.activeProvider`. Settings → `Home` → `Readiness` must show it as ready. If it isn't, the journey is blocked; report that.
- Read `bun $S config shortcuts.dictation`. A `binding` of `null` means no shortcut, so the journey is blocked. `activationMode` says whether the human presses twice (`toggle`) or holds while speaking (`push-to-talk`).
- A human is at the keyboard and microphone. `sl.ts` cannot press global hotkeys, speak, or open the tray.

- **Shortcut readiness.** Run `bun $S click settings "Shortcuts & Mic"`, then `bun $S eval settings "document.body.innerText"`. Note the chord shown in the `Dictation` row; that is what you give the human, never a chord from memory. The row must not stay on `Checking whether the shortcut is active…`, and `Pause global shortcuts` must be off.
- **Human step.** Ask the maintainer to focus a text field in another app and use the chord you read, as the activation mode requires, saying a fixed phrase. While they speak, `bun $S eval runtime "document.body.innerText"` should be non-empty because the pill is showing.
- **Result.** The maintainer confirms the phrase appeared once and the clipboard was unchanged. Check `.cache/verify-shuddhalekhan/run/app.log` for transcription errors.
- **Proof.** Shoot `runtime` while the pill shows, plus the maintainer's confirmation quoted with the platform.

## Gotchas

- Not yet proven by this skill. Treat each step as unverified until a maintainer-run pass confirms it, and report it that way.
- Linux KDE/Wayland: the dev build registers portal shortcuts under the dev desktop identity. If KDE asks to assign them, the maintainer must accept, or the hotkey does nothing.
- Without the maintainer, Bun tests under `app/src/main/__tests__/` are the strongest available proof for delivery logic. Say so instead of claiming an end-to-end pass.
