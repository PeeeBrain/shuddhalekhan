# AT-SPI EditableText receiver findings

Question: can Dictation deliver into the field focused at record start, on stock KDE Plasma Wayland, without a patched compositor or toolkit? This is the AT-SPI path that [receiver-context-feasibility.md](receiver-context-feasibility.md) left open.

Short answer: AT-SPI targets the original object exactly. It cannot insert into another field. Stock receivers do not check the context lifetime at the final edit, though, and important app families do not expose the receiving interface. The strict contract is **not met**. No production module was written.

## Mechanism

`org.a11y.atspi.EditableText.InsertText(position, text, length)` is a D-Bus method on the accessibility bus. It targets one object by `(unique bus name, object path)`. Unique bus names are never reused within a bus lifetime. GTK4 paths are per-object UUIDs; Qt paths come from its accessible id cache. Keyboard focus, the compositor, and text-input serials are not involved. A stale or reused delivery path cannot steer text into field B.

## Host evidence, 2026-11-07 (KDE Plasma/KWin 6.8.2, Qt 6.11.2, GTK 4.24.1, at-spi2-core 2.62.1)

Read-only host probe: `org.a11y.Status.IsEnabled = false`. The accessibility bus holds only infrastructure clients. Stock Plasma therefore exposes no Qt app objects to AT-SPI until accessibility is switched on. The value was still `false` after the experiment.

Isolated experiment: private `dbus-run-session`, private `XDG_RUNTIME_DIR`, `kwin_wayland --virtual`, and a manually started bus launcher and registry. Fixtures were `zenity --forms` with two entries (GTK4) and `kdialog --inputbox` (Qt Widgets `QLineEdit`). Only fixture text was read. Everything was torn down afterwards by PID.

- GTK4 entries and the Qt `QLineEdit` advertise `EditableText`. `InsertText` into the focused GTK4 entry A inserted only into A.
- A second window took activation, and A's `FOCUSED` state cleared. `InsertText` on A still succeeded and wrote into A; B was untouched.
- `InsertText` on the Qt field also succeeded while the field was unfocused and its window inactive.
- `Component.GrabFocus` was refused by GTK4. AT-SPI cannot reliably move focus back, which is fine: Dictation must never do that anyway.
- With no registered listener, no `StateChanged` signals were observed. A production receiver needs a persistent `Registry.RegisterEvent` client.

Conclusion: the destination is exact, but GTK4 and Qt do not enforce lifetime at the receiver. Every lifetime rule must be enforced by the caller.

## Toolkit coverage (source)

| Receiver | EditableText | Notes |
| --- | --- | --- |
| Qt Widgets `QLineEdit` | yes | `simplewidgets.cpp:865` uses `setText(text().insert(...))`. That resets undo and caret, emits `textChanged` but not `textEdited`, and skips the read-only check. |
| Qt `QTextEdit`/`QPlainTextEdit` | yes | `qaccessiblewidgets.cpp:1035` inserts through `QTextCursor`. |
| KTextEditor (Kate, KWrite, KDevelop) | yes | `kateviewaccessible.h:28,288` inserts through `document->insertText`. |
| Qt Quick/Kirigami text fields | **no** | `QAccessibleQuickItem` has no editable-text interface. Many Plasma surfaces use these fields. |
| GTK3 | yes | at-spi2 atk-adaptor `editabletext-adaptor.c`. |
| GTK4 `GtkEditable`/`GtkTextView` | yes | `gtkatspieditabletext.c:90-101` checks only `editable`. Verified in the experiment. |
| Firefox | yes | `nsMaiInterfaceEditableText.cpp:31` uses `HyperText::InsertText`. |
| Chromium, Chrome, Electron (VS Code, Slack, Discord, this app) | **no** | `ax_platform_node_auralinux.cc:2465-2490` registers no `AtkEditableText`. Chromium reads `IsEnabled` only at startup (`atk_util_auralinux.cc:125`). |
| Terminals | no | Terminals have no editable field object. |

Qt watches `IsEnabled` live (`dbusconnection.cpp:64`). `QT_LINUX_ACCESSIBILITY_ALWAYS_ON` forces accessibility on.

## Why the strict contract still fails

1. **Final-edit lifetime is check-then-act.** No stock `InsertText` takes a precondition such as "only if still focused" or a context token. Suppose the app handles a focus change (in-app, or a compositor deactivation configure) while our call is in flight. The text still lands in the original field after that field lost focus. It never lands in another field. Per-sender D-Bus ordering should deliver the app's focus-loss signal before our method reply, so this would be detectable afterwards, but not preventable. This ordering is inferred from source and unverified with a persistent listener. A compensating `DeleteText` would race user typing and is rejected.
2. **The default needs a host setting.** Stock Plasma has `IsEnabled=false`. Turning it on is a session-wide setting that changes every app (Firefox and Qt build full accessibility trees). This conflicts with the performance principle, and it is a user opt-in, not stock behavior.
3. **Coverage is far from system-wide.** All Chromium/Electron apps, Qt Quick/Kirigami fields, and terminals are excluded. Those exclusions cover a large share of daily KDE targets.
4. **Semantics differ from typing.** `QLineEdit` loses undo history and caret, and listeners that react only to user edits (`textEdited`) do not fire. With an active selection, the edit needs separate `DeleteText` and `InsertText` calls.

## Other receivers re-checked

- **fcitx5/IBus D-Bus frontends that bypass the compositor:** fcitx5-qt `commitString` sends to `qGuiApp->focusObject()` at receipt time (`qfcitxplatforminputcontext.cpp:696-707`). The input context is per window, not per field. This is the same final-hop race as the GTK result.
- **KWin text-input/input-method v1/v2 and fake-input:** already shown unsuitable; serials are ignored.
- **Portal RemoteDesktop/EIS keyboard:** follows current focus by design.

## What would close it

The narrowest real fix is a receiver precondition at the final edit. Two shapes could provide it:

- An upstream AT-SPI conditional edit, for example `InsertText` that fails unless the object is still focused in an active window. Qt and GTK would each have to implement it in their adaptor, on the app's own event-loop order.
- Toolkit honoring of a delivery token over text-input-v3, as in the earlier GTK experiment.

Either needs upstream agreement. Chromium additionally needs `EditableText` itself.

## API if the maintainer accepts residual 1

This trades exact field identity for a bounded "late, but in the original field" outcome. It is a contract downgrade and needs explicit sign-off.

- Opt-in only. Read `IsEnabled`; never toggle it silently.
- Start a persistent listener for `object:state-changed:focused`, `window:deactivate`, `object:state-changed:defunct`, and `NameOwnerChanged`.
- Record start captures `{bus, path, window}`. Refuse and keep Last Transcript when the target lacks `EditableText`, is `PASSWORD_TEXT`, is not `EDITABLE`, or is `READ_ONLY`.
- Any loss event invalidates the capture permanently. Regaining focus never revives it.
- Delivery reads the caret and calls `InsertText`. A loss signal from the target ordered before the reply is reported as a late delivery to the original field.
- Node has no D-Bus client in the workspace today. This needs `dbus-next` or a `gdbus` child process.
