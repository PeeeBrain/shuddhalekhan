# Windows guarantees and compatibility limits for live Unicode injection

Research for [Establish Windows guarantees and compatibility limits for live Unicode injection](https://github.com/PeeeBrain/shuddhalekhan/issues/168), under [Wayfinder: discover append-only live Dictation injection](https://github.com/PeeeBrain/shuddhalekhan/issues/166).

## Finding

Append-only live Dictation is technically feasible as a **best-effort Windows desktop input path**, but `KEYEVENTF_UNICODE` cannot provide an end-to-end delivery guarantee. Shuddhalekhan can know how many events `SendInput` inserted into Windows' input stream; it cannot know whether the intended focused control consumed, retained, normalized, transformed, or displayed the corresponding text.

This makes direct Unicode input a plausible low-latency path for compatible, non-elevated targets, with a fail-closed runtime contract and a retained finalize-once alternative. It is not a universal replacement for clipboard paste.

## What Windows guarantees

### Dispatch and ordering

- `SendInput` returns the number of events successfully inserted into the keyboard or mouse input stream. It does not return a character count or a target-control result.
- Events in **one call** are inserted serially and are not interspersed with user input or other injection calls. This does not establish atomicity across separate calls for successive committed deltas.
- Existing keyboard state is not reset; keys already held can interfere with synthesized events.
- With `KEYEVENTF_UNICODE`, `wVk` is zero and the 16-bit `wScan` value is carried by a synthesized `VK_PACKET` key event to the foreground thread's queue. If that thread retrieves and translates it, Windows posts `WM_CHAR`.

Sources: [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput), [KEYBDINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput), and [Keyboard Input Overview](https://learn.microsoft.com/en-us/windows/win32/inputdev/about-keyboard-input).

### Unicode sequences

- `wScan` is a `WORD`, so the native unit is one UTF-16 code unit, not one Unicode scalar value or grapheme cluster.
- A supplementary character therefore requires an ordered high/low surrogate pair. Unicode `WM_CHAR` supports surrogate pairs on Windows Vista and later, but the receiving application remains responsible for handling the sequence correctly.
- Combining marks and ZWJ emoji are also multi-code-unit sequences. A one-call batch preserves event ordering, but Microsoft documents no grapheme-level atomicity, normalization, rendering, or editor acceptance guarantee.
- ANSI windows may receive converted values rather than the original Unicode representation.

Sources: [WM_CHAR](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-char), [Working with Strings](https://learn.microsoft.com/en-us/windows/win32/learnwin32/working-with-strings), and [Unicode](https://learn.microsoft.com/en-us/windows/win32/intl/unicode).

### Integrity and desktop boundaries

- UIPI permits injection only into applications at an equal or lower integrity level. Neither the return value nor `GetLastError` identifies UIPI as the reason for a failure.
- Shuddhalekhan therefore cannot promise live insertion into an elevated target and must not elevate or use `UIAccess` to bypass this boundary.
- Input is scoped to the active input desktop/session. Microsoft documents that a disconnected session's input desktop is the desktop that becomes active after reconnection; it does not document that `KEYEVENTF_UNICODE` sent to a local Remote Desktop client will be preserved end to end in the remote application.

Sources: [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput), [Security Considerations for Assistive Technologies](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview), and [OpenInputDesktop](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openinputdesktop).

## What remains target-dependent

### Control consumption

Queue acceptance is not control acceptance. The foreground thread must retrieve and translate `VK_PACKET`, and the focused child control decides how to process the resulting input. Controls may be read-only, impose limits, transform case or character sets, intercept key messages, implement a non-Win32 text stack, or change focus inside the same top-level window. Windows exposes no per-character acknowledgement through `SendInput`.

The current target seam captures only the top-level foreground `HWND`, process, thread, class, and executable path. It cannot prove which browser field, editor pane, terminal surface, or child control has keyboard focus. The prior exact-original-window decision is necessary but insufficient to guarantee control-level continuity.

Sources: [Using Keyboard Input](https://learn.microsoft.com/en-us/windows/win32/inputdev/using-keyboard-input) and [About Edit Controls](https://learn.microsoft.com/en-us/windows/win32/controls/about-edit-controls). Repository evidence: [`target.ts`](https://github.com/PeeeBrain/shuddhalekhan/blob/82f77c2/app/src/main/native/target.ts) and [Define original-target identity and focus-divergence policy](https://github.com/PeeeBrain/shuddhalekhan/issues/156#issuecomment-5226008017).

### IMEs

Microsoft explicitly distinguishes IMEs that advertise `IME_PROP_ACCEPT_WIDE_VKEY`: those IMEs process injected `VK_PACKET` Unicode; otherwise the IME might not process it and Windows might send it directly to the application. There is consequently no universal promise that live injection will preserve, commit, bypass, or avoid interfering with an active composition. This requires target/IME testing and a conservative stop policy when composition interference is observed.

Source: [EM_GETIMEPROPERTY](https://learn.microsoft.com/en-us/windows/win32/controls/em-getimeproperty).

### Remote Desktop and sensitive controls

- No reviewed Microsoft source establishes end-to-end `KEYEVENTF_UNICODE` compatibility through Remote Desktop. Treat it as unproven until tested, not as guaranteed or impossible.
- Classic edit controls expose password masking through `ES_PASSWORD`/`EM_GETPASSWORDCHAR`; conforming UI Automation Edit providers expose `UIA_IsPasswordPropertyId`. Neither mechanism proves universal detection for browser, custom-rendered, inaccessible, or nonconforming controls. UI Automation may supply default property values when a provider does not implement a property.
- The current native seam has no focused-control or sensitive-field detector. A sensitive-field deny rule can reduce risk where detection succeeds, but cannot claim complete coverage without a new control-level inspection seam—and still must fail closed when inspection is unavailable if the product contract requires a hard prohibition.

Sources: [EM_GETPASSWORDCHAR](https://learn.microsoft.com/en-us/windows/win32/controls/em-getpasswordchar), [UI Automation Edit Control Type](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-supporteditcontroltype), and [Retrieving UI Automation properties](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-propertiesforclients).

## Recovery implications

The safe interpretation of each `SendInput` result is:

| Result | What is established | Safe consequence |
|---|---|---|
| `0` accepted events | This call inserted no events into the Windows input stream; cause may remain unknown, including UIPI | The delta was not dispatched by this call. A separately chosen fallback may be possible after fresh target validation. |
| All expected events accepted | Windows inserted every event, not that the control inserted every character | Advance the dispatch cursor to avoid duplication; never retry automatically. Preserve full transcript for copy/finalize recovery. |
| Between `0` and expected | Some events entered the stream, with no target-consumption acknowledgement and no documented character boundary | Halt live injection immediately; do not infer a remaining suffix, retry, or switch mechanisms automatically. Mark external insertion uncertain. |

Because every UTF-16 code unit uses a down/up pair in the prototype, an odd partial count can even split a pair. A partial count must not be converted into a trustworthy UTF-16 prefix.

## Repository and prototype evidence

The preserved prototype correctly builds one down/up pair per UTF-16 code unit and dispatches the complete sample in one `SendInput` call: [`win32-unicode.ts`](https://github.com/PeeeBrain/shuddhalekhan/blob/2aae6f5/app/src/main/native/prototype-incremental-injection/win32-unicode.ts). Its state model already distinguishes zero, full, and partial acceptance and halts on partial evidence: [`state.ts`](https://github.com/PeeeBrain/shuddhalekhan/blob/2aae6f5/app/src/main/native/prototype-incremental-injection/state.ts).

Observed compatibility is narrow:

- visually correct: VS Code Latin; Windows Terminal Latin and emoji/ZWJ; active-IME editor Latin;
- OS-accepted but not visually classified: Notepad Latin, Devanagari, emoji/ZWJ; VS Code combining marks; Windows Terminal Devanagari;
- untested/unproven: Word/Office, real browser text input, Remote Desktop, elevated targets, sensitive controls, and non-Latin input during active IME composition.

The browser `3/8` result was synthetic recovery-state evidence, not a browser compatibility result. See [Choose incremental text injection and partial-failure recovery](https://github.com/PeeeBrain/shuddhalekhan/issues/157#issuecomment-5226379163).

Current production injection uses a clipboard transaction plus a `Ctrl+V`/`Ctrl+Shift+V` `SendInput` chord, and similarly treats accepted event count as dispatch evidence rather than text acknowledgement: [`clipboard.ts`](https://github.com/PeeeBrain/shuddhalekhan/blob/82f77c2/app/src/main/native/clipboard.ts) and [`clipboard-transaction-manager.ts`](https://github.com/PeeeBrain/shuddhalekhan/blob/82f77c2/app/src/main/clipboard-transaction-manager.ts).

## Decision input for the remaining map

The next decisions can assume:

1. Direct Unicode injection is viable enough to prototype, but compatibility—not Win32 API availability—is the feasibility gate.
2. Live mode must be append-only, exact-original-window-bound, and revalidate immediately before **every** committed-delta call.
3. A full acceptance count advances the external dispatch cursor despite uncertain consumption; partial acceptance halts the session's live path; no automatic rollback or suffix retry is safe.
4. Each committed delta should be one ordered `SendInput` batch of UTF-16 down/up pairs. This minimizes interleaving within the delta but does not make a grapheme or the whole utterance transactional.
5. Elevated targets are unsupported by design. RDP, IME composition, Unicode/editor fidelity, and sensitive-control handling remain explicit compatibility/product gates.
6. The finalize-once clipboard path should remain available while those gates are unresolved and for targets where live mode is denied or unsupported.

No additional Wayfinder ticket is needed from this research: [Measure realistic committed-delta cadence and target compatibility](https://github.com/PeeeBrain/shuddhalekhan/issues/167) already owns the missing empirical matrix, while [Define append-only delta, focus-divergence, and uncertainty semantics](https://github.com/PeeeBrain/shuddhalekhan/issues/170) owns the runtime consequences.
