# Renderer audio lifetime prototype results

## Verdict

Use strict idle privacy: keep the runtime renderer, `AudioContext`, and `AudioWorklet` warm, but keep no live `MediaStreamTrack` while idle. Acquire the selected microphone for each recording and stop every track on end, cancel, error, or teardown.

The prototype was run interactively on Windows with Electron 43.1.0. Three sessions produced 15 guided strict-idle activations, a 60-second idle activation, one hidden-window activation, four backpressure trials, and a logical device switch out and back.

## Observations

- Across 15 strict-idle guided activations, start-to-first-PCM ranged from 63.3 to 257.7 ms with an 86.3 ms median.
- The first strict activation in each fresh prototype session was variable: 102.6, 226.0, and 257.7 ms. The 12 subsequent activations had an 83.8 ms median and a 63.3–90.2 ms range.
- After 60 seconds with the microphone fully stopped, start-to-first-PCM was 84.6 ms. No long-idle penalty was observed in this run.
- The user marked activation as feeling immediate in both sessions where subjective feedback was recorded.
- Device acquisition dominated latency. Once `getUserMedia()` resolved, the first fixed PCM chunk arrived 10.3–28.7 ms later in the retained reports.
- The device ignored requested mono/16 kHz capture constraints and exposed 48 kHz stereo. A 16 kHz `AudioContext` plus the worklet produced fixed 320-sample, 20 ms mono PCM16 chunks. Production must observe actual settings and retain an explicit downmix/resampling seam.
- Hidden-window capture reached first PCM in 91.7 ms and delivered 61/61 chunks. `backgroundThrottling: false` avoided an observed hidden-renderer penalty.
- A sequential consumer handled artificial acknowledgement delays of 0, 10, and 30 ms without loss with a 25-chunk (500 ms) queue. At 50 ms acknowledgement latency for 20 ms chunks, it delivered 45/61 and overflowed 16 chunks. Production must never silently drop on saturation.
- Every non-overflow realtime payload matched the renderer's buffered PCM byte-for-byte. Every constructed batch WAV payload contained the same PCM bytes.
- Every strict-idle and device-switch trial ended its microphone track.
- Switching to the browser's alternate logical endpoint took 89.8 ms; switching back took 87.6 ms. Both delivered every chunk. The browser exposed default, communications, and explicit entries for one physical Realtek microphone, so physical hotplug was not exercised.
- Process memory was noisy in the development prototype. Hidden/show initialization caused an approximately 33 MB private-byte step, after which five diagnostic captures grew by roughly 1.5 MB rather than increasing per utterance. Packaged regression budgets remain governed by the separate performance protocol.

## Resulting seam

- The persistent runtime renderer owns permission requests, device enumeration, per-recording `MediaStream` acquisition, actual-format observation, `AudioContext`, `AudioWorklet`, downmix/resampling, PCM16 conversion, level calculation, and full-utterance PCM retention.
- The worklet emits 320-sample mono PCM16 chunks at 16 kHz. The renderer forwards ordered chunks through typed IPC with sequence numbers and bounded accounting, while retaining the same source chunks for a final batch WAV.
- Main owns the recording/session state, provider capability selection, acknowledgements/flow control, streaming adapter, and fallback decision. Renderer-to-main saturation is a typed degradation/error event, never silent loss.
- On streaming failure or queue saturation, stop feeding the realtime provider, keep recording into the full utterance buffer, and use the final WAV for a batch-capable fallback when policy permits. This preserves the audio-retention requirement established by the WhisperLiveKit wire decision.
- A settings device change while idle applies to the next acquisition. A change during an active utterance is deferred until the next session. If the active track ends because of removal or driver failure, fail that utterance safely rather than switching microphones mid-speech; refresh enumeration and reacquire on the next activation.

## Remaining validation, not a design decision

- Run the performance protocol against an installed packaged build to set numeric p50/p95 regression gates; the prototype does not invent them.
- Exercise physical USB/Bluetooth removal during idle and active capture in Windows release validation.
- Verify the production AudioWorklet converter with the project's pinned audio fixtures and batch transcription path.
