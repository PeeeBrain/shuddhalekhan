# Incremental injection compatibility prototype

**PROTOTYPE — throw away after “Choose incremental text injection and partial-failure recovery” is resolved.**

This answers whether direct UTF-16 `KEYEVENTF_UNICODE` insertion can be the low-latency path across the target matrix, and whether certainty-based recovery remains safe when `SendInput` accepts none, all, or only part of an event batch.

Run from `app/`:

```powershell
bun run prototype:incremental-injection
```

Choose a target and sample, press `d`, and focus the target during the three-second countdown. Return to the terminal to record the visible outcome. `q` prints a Markdown matrix that can be pasted into the issue.

The `a` key is a synthetic partial-dispatch demonstration. It exercises the halt/recovery state without writing a compatibility result into the selected matrix cell.

The harness never sends Enter. It refuses the sensitive-field row because the current native seam has no reliable sensitive-field detector. A zero-event result permits whole-delta clipboard fallback; a full result must not be retried because `SendInput` only confirms queue acceptance, not application insertion; a partial result halts automatic insertion because retrying may duplicate an unknowable prefix.
