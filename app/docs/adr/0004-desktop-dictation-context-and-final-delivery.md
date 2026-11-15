# Desktop Dictation uses previews and final delivery

Status: accepted on 2026-11-06. Strict Wayland delivery is blocked on an upstream receiver contract (see Receiver findings).

## Decision

Dictation shows revisable previews while recording and makes one automatic delivery attempt after recognition and optional cleanup finish. Progressive external typing is removed in the app implementation. Saved Live settings migrate to ordinary Dictation, while shortcuts and recognition choices stay intact.

Wayland delivery must use the original input context. Pasting into whichever field is focused at dispatch is insufficient. Unknown context blocks automatic delivery and preserves Last Transcript for explicit recovery. Focus loss, context destruction, or engine disable invalidates pending delivery; regaining focus must not revive it.

## Why

The maintainer selected both choices during implementation of [#240](https://github.com/PeeeBrain/shuddhalekhan/issues/240). Final-only delivery removes the need to treat provisional recognition as irrevocable keystrokes. Requiring the original context makes focus safety a backend requirement rather than a warning attached to unrestricted foreground paste.

Portal shortcut availability is useful for activation, but does not establish a text destination. A portal keyboard session cannot prove which field originally held focus. It is not the primary Wayland delivery candidate under this decision.

## Consequences

- Prove receiver validation on native Wayland before enabling automatic delivery. Installed input-method APIs do not establish app compatibility.
- Verify whether context identities and focus/reset events distinguish field changes in actual editors, browsers, terminals, and Electron apps. A toolkit can reuse its input context; a stable context identifier is not automatically a stable field or caret.
- Keep Electron initially. Reconsider only when the native mechanism demonstrates a concrete runtime limitation.
- Keep Dictation independent from Agent Mode. Shared capture still routes one final Agent command to the existing sidecar entry point.
- Preserve provider settings, recognition preferences, credentials, model assets, and independent shortcuts. Migrate Live to previews plus final insertion with a concise explanation.
- Clipboard/SendInput remains the current Windows implementation while feasibility work proceeds. Its process/window checks must not be advertised as exact text-field identity.

## Receiver findings (2026-11-07)

No app-side adapter can meet the contract. Every path Shuddhalekhan can drive from outside the receiving app checks focus in one process and edits in another: portal/EIS, uinput and XTEST type into the current focus; KWin 6.8.2 ignores stale text-input serials; GNOME's IBus/Mutter path and fcitx5/IBus frontends commit to whatever the toolkit focuses on receipt; AT-SPI `InsertText` reaches the exact object but still edits after focus loss, and Chromium/Electron, Qt Quick and terminals lack it. An isolated GNOME/GTK prototype confirmed the race lives in the final toolkit hop: a held commit landed in the newly focused field with stock GTK and nowhere with a patched GTK.

A toolkit input-method module (GTK `GtkIMContext`, Qt `QPlatformInputContext`) could check and edit atomically, but it needs a session-wide input-method setting, displaces the user's IBus/fcitx IME, misses Chromium/Electron on native Wayland, and needs four ABI targets. Those are product-scope blockers.

Strict delivery needs upstream agreement on either a receiver-issued field token over text-input-v3 (Mutter, KWin, GTK, Qt, Chromium Ozone, terminals) or a conditional AT-SPI edit that fails after focus loss. Until then, Wayland keeps Last Transcript as the explicit recovery path. KDE has an opt-in best-effort test mode that validates the original window, not the field; it does not meet this contract (see `CONTEXT.md`). Local work could resume only if the maintainer accepts GTK/Qt-only coverage or an opt-in session input-method change.
