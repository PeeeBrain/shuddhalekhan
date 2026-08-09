# PROTOTYPE — Agent runtime process boundary

This throwaway prototype asks one question: **Does Electron `utilityProcess` provide enough measurable or lifecycle advantage over the existing main-owned stdio sidecar to justify migration?**

Run it from the repository root:

```powershell
bun run prototype:agent-boundary
```

The terminal UI runs the current packaged-style boundary (Electron as Node over stdin/stdout JSONL) and a `utilityProcess` candidate under the same Electron binary. It displays the full result state after every action and probes:

- first and repeated process readiness;
- first and warm synthetic Agent work;
- IPC round-trip latency;
- Windows private bytes and working set;
- explicit cancellation acknowledgement;
- parent-observed crash and restart;
- worker-owned in-memory SQLite using the production native dependency.

The synthetic work deliberately performs no network calls and writes only to an in-memory SQLite database. This is directional evidence, not the packaged performance baseline defined by the Wayfinder map: it does not test an installed NSIS build, real model or MCP traffic, Windows Job Object containment, ABBA repetitions, or A/A-derived regression gates.

The first launch of each candidate is shown separately as an uncontrolled observation because OS/module-cache order can dominate it. Each mechanism is then prewarmed before the readiness samples used in the comparison.

Once both candidates have run, the UI also prints a provisional comparison. It is deliberately phrased as a migration trigger check rather than a final decision; the Wayfinder ticket remains human-in-the-loop until the result has been reviewed.

## Human-validated verdict

**Keep and harden the current main-owned stdio sidecar.** The prototype was reviewed and accepted on 2026-08-09.

Across two corrected directional runs on Electron 43.1.0 / Node 24.18.0:

- warmed stdio-sidecar readiness was approximately 202–206 ms p50, versus 215–233 ms for `utilityProcess`;
- private-memory results overlapped run noise, while the utility process used approximately 6–10% more working set;
- the utility process reduced median synthetic IPC by only 0.04–0.05 ms;
- both candidates preserved process isolation, worker-owned native SQLite, explicit cancellation, parent-observed failure, and restart;
- `utilityProcess` would replace stdin/stdout JSONL with MessagePort IPC without removing the child process, Windows Job Object requirement, generation/restart state, or shutdown protocol.

The unique utility-process benefits—Electron process metrics/service naming, Chromium-integrated exit reporting, and transferable renderer `MessagePort`s—do not justify migration for the current main-to-Agent protocol. Reconsider only if one becomes a concrete requirement or the packaged performance protocol later finds a material regression in the stdio boundary.

The prototype is intentionally adjacent to `agent-sidecar.ts` and must not be merged into production. After a human verdict, capture this branch as the primary source and lift only the validated decision into the implementation spec.
