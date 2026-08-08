# PROTOTYPE — renderer audio lifetime

This throwaway Windows/Electron prototype answers one question for the Wayfinder ticket **Choose the renderer audio lifetime and PCM chunk seam**:

> Can Shuddhalekhan stop every microphone track while idle, while keeping one renderer, `AudioContext`, and `AudioWorklet` warm, and still achieve acceptable first-PCM latency with fixed 20 ms PCM16 chunks and an equivalent batch payload?

It is deliberately isolated from production code. It records no audio to disk by default. The optional export contains timing/resource metadata only.

Run from `app/`:

```powershell
bun run prototype:audio-lifetime
```

Recommended protocol:

1. Prepare permission once, select the real device, and leave the renderer/worklet warm.
2. Run five strict-idle trials with a 1-second interval.
3. Run five strict-idle trials after a 60-second idle interval.
4. Repeat one sequence with the Electron window hidden.
5. Run the retained-track comparator only if the Windows microphone indicator is acceptable during that comparison; stop it immediately afterward.
6. Repeat with sink delays of 0, 10, 30, and 50 ms. A 20 ms chunk cadence should reveal the bounded-queue backpressure threshold.
7. Export the report JSON and compare shortcut-equivalent start-to-first-PCM latency, device-open latency, queue drops, batch/delivered hashes, actual sample rates, and process metrics.

Privacy invariant under the strict policy: every `MediaStreamTrack` is stopped at the end of each trial. Keeping the renderer, `AudioContext`, and worklet warm does not retain microphone access.

The completed interactive findings and resulting ownership seam are recorded in [RESULTS.md](RESULTS.md).
