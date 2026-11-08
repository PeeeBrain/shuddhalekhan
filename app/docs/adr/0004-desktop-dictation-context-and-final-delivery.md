# Desktop Dictation uses previews and final delivery

Status: product direction accepted on 2026-11-06; native backend feasibility pending.

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

## Open evidence

No input-method backend is certified. Record observed desktop capabilities and manual integration gates in [desktop-dictation-feasibility.md](../desktop-dictation-feasibility.md). The [implementation plan](../desktop-dictation-overhaul-plan.md) remains the work order; its first milestone is not complete merely because portal properties are readable.

The [receiver investigation](../receiver-context-feasibility.md) found missing receiver-side validation in the inspected KWin 6.8.2 commit handler and GNOME stock IBus/event path. It does not establish that every desktop-specific integration is impossible.

The maintainer subsequently selected strict safety and authorized investigation of receiver/compositor integrations. Best-effort validation is not the selected contract. Prepare isolated, pinned receiver prototypes and trace the final application/toolkit hop as well as compositor routing. A compositor-side context or surface token alone must not be described as exact field identity. Neither IBus nor portal delivery is certified. This decision authorizes investigation artifacts; it does not itself authorize replacing the running compositor or changing desktop input-method settings.

## Receiver experiment outcome, 2026-11-07

The isolated GNOME Shell and two-field GTK fixture exercised real delivery. Both variants used patched mutter and differed only in the experimental GTK change. When an old commit batch was held until local focus moved from A to B, unpatched GTK inserted into B and patched GTK inserted nowhere. Normal delivery, duplicate refusal, stale focus refusal, return-to-field refusal, and superseded-token handling passed. See the [retained findings](../receiver-context-feasibility.md). The probes, patches and raw evidence were archived outside the repository.

This is evidence for toolkit participation in this receiver design, not certification of GNOME/KDE or all GTK applications. Keep Electron and continue independent previews/finalization work without treating these private desktop forks as product dependencies. Strict Wayland automatic delivery remains gated on a negotiated receiving contract and application coverage. No safety downgrade is implied.
