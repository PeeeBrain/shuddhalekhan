# Strict Wayland receiver: implementation status

Status, 2026-11-07: **blocked. No production receiver is shipped.** This note records why no local adapter can meet the selected contract and what external change would. It builds on the [compositor/toolkit findings](receiver-context-feasibility.md) and the [AT-SPI findings](receiver-atspi-feasibility.md); it repeats no experiments.

## Selected contract

Automatic Dictation delivery lands only in the field that had focus at record start. If that field loses focus, is destroyed, or the engine is disabled, delivery is cancelled. Regaining focus does not revive it. A late delivery into the original field is not accepted. Silently pasting into the current focus is not accepted either. Acceptance requires automatic insertion on both GNOME and KDE.

## Why an adapter in our app cannot meet it

The insertion runs in the receiving app's main loop, against that app's notion of the focused widget. Only that event loop knows, at the moment of the edit, whether the original field still owns input. Every path Shuddhalekhan can drive from outside the app checks focus in one process and edits in another:

| Path | Where the check happens | Result |
| --- | --- | --- |
| Portal RemoteDesktop/EIS, uinput, XTEST | none (current focus) | Can type into another field |
| KWin input-method / text-input serials | compositor (KWin ignores stale serials) | Can type into another field |
| GNOME IBus / Mutter | compositor queue | Toolkit can switch fields after the check (shown with stock GTK) |
| fcitx5/IBus D-Bus frontends | IM daemon; the app commits to `focusObject()` on receipt | Same toolkit race |
| AT-SPI `EditableText.InsertText` | caller; addressed to the exact object | Edits still land after focus loss; Chromium/Electron, Qt Quick, and terminals lack the interface |

Adding another out-of-process adapter only moves the check to a different process. The check-then-edit race remains. The remedy is a check inside the receiver's event loop.

## Code that runs in the receiver without replacing the toolkit

Toolkit input-method modules run in-process: GTK3/GTK4 `GtkIMContext` modules and Qt `QPlatformInputContext` plugins. Such a module could take a delivery request on the app's main thread, confirm that the focused client widget is still the one recorded at start and has never lost focus, and emit the commit in that same dispatch. The check and the edit would then be atomic with respect to focus changes. This option was not covered by the earlier investigations. It is the strongest local candidate. It still fails the gate:

1. **It requires a host input-method setting.** The module loads only when `GTK_IM_MODULE`, `QT_IM_MODULE`, or the GTK `gtk-im-module` setting selects it for the whole session. This host has none set: GNOME uses GTK's `wayland` module and KDE uses Qt's Wayland text-input. ADR 0004 does not authorize changing desktop input-method settings.
2. **It replaces the user's IME.** GTK and Qt each load one module per context. IBus/fcitx users would lose composition unless our module proxied the real IME. That means re-implementing each module's protocol, so the proxy is a fork in practice.
3. **Expected coverage stays partial.** A module could reach GTK and Qt applications that select it, potentially including Firefox (GTK3), VTE terminals, Konsole, and Qt Quick. None of that application coverage has been tested. Chromium/Electron on native Wayland uses text-input directly rather than `GtkIMContext`, so support cannot be assumed. Non-toolkit terminals, sandboxed runtimes that cannot load host modules, and XWayland applications using XIM also need separate integrations. The required coverage includes VS Code, Slack, Discord and Chrome.
4. **It needs four native ABI targets** (GTK3, GTK4, Qt5, Qt6) packaged per distro layout (`/usr/lib64` vs Debian multiarch, `gtk-query-immodules-3.0` cache). The packaging also inherits each toolkit's IM ABI churn.
5. **Its atomicity is unproven.** No test has shown that window deactivation always reaches the module (`focus_out` / `focusObjectChanged`) before a queued delivery dispatch.

Points 1 to 3 conflict with both the selected contract and the GNOME+KDE acceptance gate. These are product-scope blockers, not engineering effort. Per instruction, no module was prototyped.

## Exact external changes for system-wide strict delivery

Either option below needs upstream agreement:

- **Delivery token over text-input-v3** (the earlier GTK experiment): a wayland-protocols extension that binds a commit to a receiver-issued field token and requires the client to drop it on mismatch. It must be implemented in Mutter, KWin, GTK3/GTK4, Qt, Chromium Ozone, and every terminal that implements text-input directly.
- **Conditional AT-SPI edit**: an `InsertText` variant that fails unless the object is still focused in an active window and has not lost focus since a caller-supplied token. It must be implemented in the GTK, Qt, and Firefox adaptors. Chromium also needs `EditableText`, and Qt Quick needs an editable-text interface. Terminals still lack coverage.

## Decisions that would unblock local work

Each of these is the maintainer's call. None is assumed here.

- Accept **narrowed coverage**: GTK and Qt apps only, with Chromium/Electron, non-toolkit terminals, and Flatpak excluded and reported as unsupported before recording.
- Authorize an **opt-in session input-method change**, with a plan for existing IBus/fcitx users.

Those decisions would authorize a limited prototype; they would not establish atomic focus invalidation or satisfy system-wide coverage. Strict automatic Wayland delivery remains disabled until the receiver contract is proven. Last Transcript remains the explicit recovery path.

## Best-effort test mode (KDE only)

On 2026-11-07 the maintainer authorized an opt-in, clearly labelled best-effort insertion mode for KDE Wayland test builds. It does **not** meet the selected contract above: it validates the original window, not the original field, and its check-then-edit race remains. See `CONTEXT.md` for its exact behavior and residual limits.
