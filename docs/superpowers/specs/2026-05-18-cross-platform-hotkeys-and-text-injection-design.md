# Cross-Platform Hotkeys and Text Injection Design

## Purpose

Shuddhalekhan should support global Dictation and Agent Mode shortcuts on Windows, macOS, and Linux without changing the core recording lifecycle. Cross-platform support must preserve the product contract: the user can trigger recording from outside the app, speak, and have the result injected into the currently focused application.

This spec covers shortcut configuration, trigger modes, registration behavior, and text injection fallback semantics. Packaging, CI, and platform-specific permission strategy are covered in separate specs.

## Current Context

Today, Windows support is implemented through `koffi`:

- `src/main/native/keyboard.ts` installs a low-level Windows keyboard hook and maps `Ctrl + Win` to Dictation and `Alt + Win` to Agent Mode.
- `src/main/native/clipboard.ts` uses `SendInput` to simulate `Ctrl + V`.
- `src/main/recording-session.ts` already exposes the lifecycle verbs needed by future platform providers: `begin(intent)`, `end()`, `cancel()`, and `isActive()`.
- `src/main/inject-text.ts` already implements the clipboard sandwich pattern: save clipboard, write transcript, simulate paste, restore original clipboard.

The design should adapt new platform input providers into these existing primitives. It should not rewrite audio capture, transcription, or Dictation/Agent routing.

## Product Requirements

Every supported OS must provide a global hotkey path for Dictation and Agent Mode. The app window must not need to be focused.

Hotkeys become user-configurable. The UI uses a focused recorder sheet, similar in spirit to Raycast shortcut recording:

1. User chooses an action: Dictation or Agent Mode.
2. Settings enters a temporary shortcut recording state.
3. User presses the desired shortcut.
4. Shuddhalekhan validates registration with the current platform provider.
5. User can save only if registration succeeds or the provider can authoritatively mark the shortcut as ready.

Default shortcuts are suggestions, not entitlements. If the OS or another app already owns the default Dictation or Agent Mode shortcut, Shuddhalekhan must not override it. The affected action remains unassigned until the user records a usable shortcut.

Dictation and Agent Mode shortcut readiness are independent. Dictation may be ready while Agent Mode is unassigned or disabled. Agent Mode may have a configured shortcut that remains inactive until Agent Mode is enabled.

## Trigger Modes

Each shortcut action has a trigger mode:

- `hold`: key-down starts recording, key-up ends recording.
- `toggle`: each activation toggles between idle and recording.

Hold mode maps to the existing lifecycle:

```ts
onShortcutDown(action) => recordingSession.begin(intent)
onShortcutUp(action) => recordingSession.end()
```

Toggle mode also maps to the existing lifecycle:

```ts
onShortcutActivated(action) => {
  if (recordingSession.isActive()) {
    return recordingSession.end();
  }

  recordingSession.begin(intent);
}
```

The focused recorder sheet should expose a restrained `Hold` / `Toggle` choice per action. Hold is the default where press/release events are supported. Toggle is the default where the platform only provides activation callbacks. Unsupported modes remain visible but disabled with a concise reason.

This is a trigger-layer feature, not a recording-session rewrite.

## Shortcut Registration Semantics

Shortcut configuration is strict:

- Save only successfully registered shortcuts.
- Block save when the shortcut is already used by another Shuddhalekhan action.
- Block save when the OS reports that the shortcut is reserved or unavailable.
- Keep defaults unassigned if the platform cannot register them.
- Report action readiness independently.

The recorder sheet should show concrete states:

- `Available`: save enabled.
- `Already used by Shuddhalekhan`: save disabled and names the conflicting action.
- `Reserved by system`: save disabled.
- `Needs desktop setup`: save disabled or guides the user through platform setup.
- `Cannot verify on this desktop`: allowed only if the provider supports deferred authoritative registration.

## Text Injection

The clipboard sandwich remains the cross-platform text injection contract:

1. Save the previous clipboard text.
2. Write the transcript to the clipboard.
3. Simulate paste into the focused app.
4. Restore the previous clipboard text after successful paste.

The platform-specific boundary is paste simulation and capability reporting:

- Windows may continue using `SendInput`.
- macOS should use the platform paste command or an approved Accessibility path.
- Linux must account for Wayland/X11 constraints.

Direct character-by-character typing is not the primary strategy because it is slower and fragile with multilingual text, IMEs, and keyboard layouts.

If paste simulation is unavailable or blocked after transcription succeeds, Dictation degrades:

- Leave the transcribed text on the clipboard.
- Show a clear paste-blocked notification.
- Do not restore the previous clipboard in that failure path.
- Do not present the operation as successful focused-app injection.

## Out Of Scope

This spec does not include:

- Replacing Windows `koffi` with Electron APIs.
- Adding a user-facing CLI action interface.
- Rewriting `RecordingSession`.
- Changing Whisper transcription behavior.
- Packaging and release workflow changes.

Normalizing Windows away from `koffi` is a future refactor after Electron APIs prove they can preserve Windows behavior.

## Testing Requirements

Unit tests should cover:

- Shortcut validation rejects conflicts and unavailable bindings.
- Dictation and Agent Mode readiness are independent.
- Hold mode maps to `begin(intent)` and `end()`.
- Toggle mode maps to `begin(intent)` when idle and `end()` when active.
- Paste failure leaves transcript on clipboard and reports degraded completion.
- Successful paste restores the previous clipboard.

Platform integration tests should be added where practical, but real desktop validation remains necessary for global shortcuts and focused-app paste behavior.
