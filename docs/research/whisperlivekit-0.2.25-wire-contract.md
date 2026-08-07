# WhisperLiveKit 0.2.25 realtime wire and flush contract

Research for [Verify the WhisperLiveKit realtime wire and flush contract](https://github.com/PeeeBrain/shuddhalekhan/issues/149). This is an architectural research artifact, not an implementation.

## Resolution

Implement WhisperLiveKit as a distinct streaming-capable provider and keep the existing batch `Transcriber` path. For the first streaming integration, use native `/asr` in `mode=full`, treat non-silence `lines` as the sole committed/stable transcript, treat `buffer_transcription` as a replaceable tentative snapshot for Shuddhalekhan UI only, and complete by sending one empty **binary** WebSocket frame and waiting for `{"type":"ready_to_stop"}` before closing.

Do not auto-resume an utterance on a new socket. The native protocol has no session ID, acknowledgement, replay cursor, or resume operation. Retain the complete utterance locally while streaming so `/v1/audio/transcriptions` can provide a stop-time batch fallback. Reconciliation with already-inserted stable text belongs to the transcript-ledger decision; pasting the batch response wholesale would duplicate text.

## Verification scope

- Running local service inspected on 2026-08-08: package `whisperlivekit==0.2.25`; container command `wlk --host 0.0.0.0 --backend-policy localagreement --backend faster-whisper --model large-v3-turbo --language auto --pcm-input`.
- The installed `basic_server.py`, `audio_processor.py`, `diff_protocol.py`, `timed_objects.py`, and bundled web client match the normalized SHA-256 content of official tag [`v0.2.25` (`db78a58`)](https://github.com/QuentinFuxa/WhisperLiveKit/tree/db78a58f3dc02528cf989f7be827d0ff248873dc). The derivative image therefore changes packaging/compute configuration, not these protocol sources.
- Primary sources: [native server and REST routes](https://github.com/QuentinFuxa/WhisperLiveKit/blob/db78a58f3dc02528cf989f7be827d0ff248873dc/whisperlivekit/basic_server.py), [audio stop/finalization pipeline](https://github.com/QuentinFuxa/WhisperLiveKit/blob/db78a58f3dc02528cf989f7be827d0ff248873dc/whisperlivekit/audio_processor.py), [wire DTOs](https://github.com/QuentinFuxa/WhisperLiveKit/blob/db78a58f3dc02528cf989f7be827d0ff248873dc/whisperlivekit/timed_objects.py), [diff protocol](https://github.com/QuentinFuxa/WhisperLiveKit/blob/db78a58f3dc02528cf989f7be827d0ff248873dc/whisperlivekit/diff_protocol.py), [official API reference](https://github.com/QuentinFuxa/WhisperLiveKit/blob/db78a58f3dc02528cf989f7be827d0ff248873dc/docs/API.md), and [official PCM worker](https://github.com/QuentinFuxa/WhisperLiveKit/blob/db78a58f3dc02528cf989f7be827d0ff248873dc/whisperlivekit/web/recorder_worker.js).

## Verified native WebSocket contract

### Connection and configuration

- Endpoint: `ws://host:port/asr` (use `wss` when TLS is configured).
- Recognized query parameters in 0.2.25 are `language`, `target_language`, `mode`, and `token`. `language` is a per-session override; omit it to use the server setting or pass `auto`. `target_language` only has an effect when the server was started with translation support. `token` is an alternative to `Authorization: Bearer ...` when the server has an API token.
- The browser WebSocket API cannot supply an arbitrary Authorization header, so renderer-owned WebSockets can only use the query-token form if server authentication is enabled. That security/product choice is not needed for the current unauthenticated loopback service.
- After acceptance, the first JSON message is `{"type":"config","useAudioWorklet":true,"mode":"full"}` for the current service. Shuddhalekhan must wait for and validate this before audio. `useAudioWorklet:true` means raw PCM is expected. If it is false, the server expects an encoded stream through FFmpeg; this provider should fail over rather than send PCM under the wrong contract.
- `mode` defaults to `full`. Source only branches specially for the exact string `diff`; unknown values are echoed but otherwise behave as full mode. The client should restrict configuration to `full` or `diff` itself.

### Client audio

- Each audio message is a binary WebSocket frame. With PCM input enabled its payload is headerless signed PCM16 little-endian, 16,000 Hz, mono.
- Frame boundaries are not semantic. Bytes are accumulated, aligned to two-byte samples, and fed when the configured minimum chunk is available; remaining aligned PCM is flushed on end-of-audio. A 4,096-sample Shuddhalekhan block becomes an 8,192-byte frame and is valid.
- Float conversion used by the official worker is clamp to `[-1,1]`, multiply negative values by `0x8000` and nonnegative values by `0x7fff`, then write signed int16 little-endian.
- WebAudio constraints do not guarantee the actual context rate. The official client resamples from `audioContext.sampleRate` to 16 kHz before PCM conversion. Shuddhalekhan must do the same when its actual rate is not 16 kHz.
- There is no per-frame acknowledgement or flow-control message.

### Full-mode server messages

Transcription state messages in full mode have **no `type` field**. Their exact 0.2.25 shape is:

```json
{
  "status": "active_transcription",
  "lines": [{"speaker": 1, "text": " committed text", "start": "0:00:00.00", "end": "0:00:01.42"}],
  "buffer_transcription": " tentative tail",
  "buffer_diarization": "",
  "buffer_translation": "",
  "remaining_time_transcription": 0,
  "remaining_time_transcription_processing": 0,
  "remaining_time_transcription_policy": 0,
  "remaining_time_diarization": 0
}
```

- `lines` is the current full committed state, not a list of newly committed deltas. A final line can grow as more committed tokens arrive. There are no segment IDs.
- `buffer_transcription` is the current unstable hypothesis tail and replaces the prior buffer wholesale. It is not a delta and must never be externally inserted.
- Normal lines have `speaker:1` when diarization is disabled. Silence has `speaker:-2` and must be excluded from transcript text. Although the API document says silence text is `null`, both 0.2.25 source and the running service emit an empty string. Timestamps use `H:MM:SS.cc` centisecond precision.
- Text can carry leading whitespace. Do not trim each update before ledger comparison.
- `status` is normally `active_transcription` or `no_audio_detected`. A formatter-level runtime failure can yield `status:"error"` plus `error`; clients must also tolerate an `error` field on other state messages.
- Source polling sends a state only when it changes. There is no promised cadence.

### Stable versus tentative semantics

For LocalAgreement, the processor places agreed tokens in persistent `State.tokens`; those become `lines`. The current hypothesis tail is `State.buffer_transcription`; that becomes `buffer_transcription`. This is the server-owned stability decision Shuddhalekhan should consume rather than reproduce.

A live paced-speech trace demonstrated monotonic committed growth while speech was still arriving:

```text
lines=""                                      buffer="The quick brown fox"
lines=" The"                                  buffer=" quick brown fox"
lines=" The quick brown fox"                  buffer=" jumps"
lines=" The quick brown fox jumps"            buffer=" over the lazy dog"
lines=" The quick brown fox ... stable words" buffer=" while"
```

The transcript ledger should reconstruct committed text from ordered non-silence line text on every state message, then validate/derive an append delta. It must not treat line objects as immutable append events. Full mode has unlimited history by default, but a server-level retention override can prune history; that needs an explicit ledger fault/fallback path.

### End of stream and final de-duplication

The only graceful native `/asr` end signal is an empty **binary** frame. After receiving it, the server:

1. stops accepting later audio;
2. flushes any partial PCM block;
3. sends an internal end sentinel;
4. calls the online processor finalizer and commits returned final tokens;
5. continues sending changed state messages; and
6. after all result processing completes, sends `{"type":"ready_to_stop"}`.

WebSocket ordering makes `ready_to_stop` the completion barrier: apply every preceding committed `lines` state, then close the socket. Closing the socket first is not a flush—the server cancels its result task and cleans up.

A stop-mid-utterance trace against the local 0.2.25 service found this sequence:

```text
before EOF: lines=""                             buffer="the quick brown fox"
send zero-length binary frame
after EOF:  lines="the quick brown fox"          buffer="jumps"
final:      lines="the quick brown fox jumps…"   buffer="over the …"  (overlaps lines)
ready_to_stop
```

This proves a critical 0.2.25 behavior: the last tentative buffer can remain nonempty and overlap final committed lines. Never promote or append the buffer on stop, including at `ready_to_stop`. Only the final `lines` state is committed. There is no separate final-transcript payload.

Use an application timeout while waiting for `ready_to_stop`; the native WebSocket path specifies no server-side completion timeout. A clean close before the barrier, socket error, timeout, malformed message, schema mismatch, or error state is a failed streaming session.

### Diff mode

`mode=diff` is opt-in and documented as experimental. The first state is `{"type":"snapshot","seq":1,...full state}`. Later messages are `{"type":"diff","seq":N,"n_lines":...}` with optional `lines_pruned`, optional `new_lines`, and wholesale replacement buffer/lag fields. `n_lines` is an integrity check. There is no in-session resync request.

Use full mode initially: dictation sessions are bounded, full mode is what the bundled client uses, and it avoids making the first integration depend on the experimental reconstruction protocol. Diff mode is a later bandwidth optimization after measurement.

## Verified failure and reconnect facts

- With API-token protection, invalid/missing WebSocket credentials are rejected with close code `4401` and reason `invalid or missing API token`.
- A session-construction `ValueError` is sent as `{"type":"error","error":"..."}` followed by close code `4400` and reason `invalid session parameters`.
- Formatter-detected FFmpeg errors appear in transcription state. Other processor exceptions can be logged and swallowed by 0.2.25, so the native protocol does not guarantee a structured error for every failure.
- The protocol has no resume token, server session identifier, received-audio offset, committed-text revision, or replay acknowledgement. Reconnecting creates a fresh `AudioProcessor` and cannot resume the same server utterance.

Therefore Shuddhalekhan should not follow the bundled demo’s presentation-oriented auto-reconnect behavior for dictation. Once a streaming socket fails, stop sending/inserting new streaming output for that utterance, retain capture locally, and use the batch fallback at stop. A later ledger decision must define how a fallback result is reconciled with text already inserted before the failure.

## Verified REST fallback

- `POST /v1/audio/transcriptions` accepts multipart `file` (required), `model` (accepted/ignored), `language`, `prompt` (accepted/ignored), `response_format`, and `timestamp_granularities` (accepted for compatibility). Audio is converted by FFmpeg to PCM16/16-kHz/mono and passed through the same processor.
- Default `response_format=json` returns `{"text":"..."}`. Other supported formats are `verbose_json`, plain `text`, `srt`, and `vtt`.
- Relevant errors are 401 for a missing/invalid configured bearer token, 400 for empty/undecodable audio or invalid construction, 413 above 512 MiB, 408 when processing exceeds the configured/derived budget, and FastAPI validation errors such as 422 for a missing file.
- `GET /health` on the local service returned `{"status":"ok","backend":"faster-whisper","ready":true}`. It does not expose a protocol/package version. `/v1/models` exposes the configured backend/model, not the server version.
- There is no `/v1/audio/translations` route in 0.2.25.

The existing Shuddhalekhan local whisper.cpp request can obtain a basic batch transcription if its configured endpoint is changed to the full WhisperLiveKit REST URL: a live request including its extra `temperature`, `translate`, and `prompt` fields returned HTTP 200 with `{"text":...}`. FastAPI ignored the undeclared `temperature` and `translate` fields; `prompt` is explicitly accepted but ignored. Consequently this is transport-compatible only for transcription—not equivalent for translation, dictionary prompting, or filler-removal prompting.

## Repository implications (recommended, not wire facts)

- Add a dedicated WhisperLiveKit provider/config instead of silently repurposing `local-whisper-cpp`. Its distinct base URLs, health route, streaming capability, optional token story, and truthful capabilities justify a separate identity and preserve the legacy fallback.
- Keep the existing batch `Transcriber` contract intact. Add a sibling streaming capability/session seam only for providers that support it.
- The renderer may own PCM capture and the WebSocket, but session/target/insertion orchestration remains authoritative outside the wire adapter. Record the same Float32 blocks into a local batch buffer until the utterance is terminal.
- Validate the config handshake (`useAudioWorklet === true`, supported mode), state schema, and monotonic ledger expectation. Fail closed to batch when they do not hold.
- Pin compatibility tests to WhisperLiveKit 0.2.25. Because `/health` has no version negotiation, acceptance must be behavioral rather than version-discovery based.

## Evidence still worth gathering during implementation

The wire decision is resolved. Implementation tests should still cover Marathi/auto-language whitespace and punctuation, stop during a tentative tail, empty/silent audio, socket loss after some stable insertion, a never-arriving `ready_to_stop`, server restart, unexpected history pruning, and browser-WebSocket token handling if authenticated local service becomes a product requirement.