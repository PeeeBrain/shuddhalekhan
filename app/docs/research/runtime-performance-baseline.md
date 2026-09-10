# Runtime performance baseline and regression protocol

Research resolution for [Define the performance baseline and regression measurement protocol](https://github.com/PeeeBrain/shuddhalekhan/issues/150).

## Decision

Use a two-layer benchmark:

1. A lightweight, opt-in structured marker stream from the packaged app, with all primary in-app intervals timestamped in Electron main.
2. An external Windows harness that launches scenarios, timestamps pre-main events, samples the process tree, Docker, and NVIDIA GPU, and produces raw and summarized artifacts.

Task Manager screenshots and stopwatches are diagnostic only. Chromium tracing and WPR/ETW are escalation tools, not the default regression lane. This keeps routine measurements low-overhead while retaining a path to explain a regression.

The implementation for #176 lives under `app/scripts/performance/`, with the packaged-run entry points in `runtime-scenario-runner.ps1` and `runtime-benchmark.ts`.

## Repository facts that shape the protocol

- `app/src/main/index.ts` has no operational-ready or performance event contract. Agent Mode starts `AgentSidecarManager` during app startup when enabled.
- `RecordingSession.start()` prewarms the single startup-warmed `RuntimeShell` BrowserWindow. The shell stays hidden while idle and owns per-recording audio capture plus recording, processing, and recovery presentation. Settings is a singleton only while open, so a post-use run contains at most two BrowserWindows.
- `RuntimeShell` sets `backgroundThrottling: false`; its renderer opens the microphone on each recording, creates a 16 kHz `AudioContext`, and receives 4096-sample blocks.
- Current completion is `stop -> WAV encode -> Transcriber.transcribe -> inject`; there are no first-token or stable-commit events yet.
- The sidecar is a hidden child process using JSONL. It emits `sidecar:ready`, MCP status/tool discovery, response deltas, approvals, and terminal events, but its PID and spawn time are not exposed.
- Enabled MCP servers connect concurrently on every sidecar `config:update`. The stdio transport owns further subprocesses; HTTP servers are external.
- Existing release validation proves packaging and an eight-second process smoke check, not performance.

## Clock and event contract

### Clock rule

- Primary in-app intervals use one monotonic clock in Electron main: Node `performance.now()`. Renderer and sidecar events are timestamped when main receives them. This intentionally includes IPC/JSONL delay because that delay is part of the user-visible path.
- Pre-main startup and all external samples use `System.Diagnostics.Stopwatch.GetTimestamp()`; on Windows this is backed by QPC when available. Capture `Stopwatch.Frequency` once and convert only during report generation.
- Every record also carries UTC ISO time for correlation, but wall time is never used for a duration.
- Renderer-local and sidecar-local timestamps may be retained for decomposition, but never subtract timestamps from different process clocks.
- A marker is JSONL with `schemaVersion`, `runId`, `scenarioId`, monotonically increasing `sequence`, `event`, `mainMonotonicMs`, `utc`, `pid`, `processRole`, and relevant IDs (`recordingSessionId`, `agentRunId`, `serverId`, `surface`). Do not record transcript text, MCP arguments, secrets, or environment values.

### Canonical events and metric definitions

| Metric | Start event | End event | Required decomposition |
|---|---|---|---|
| Cold application startup | External `process.launch.requested` immediately before `Process.Start` | External receipt of `runtime.operational` | `app.electron-ready`; tray ready; hotkey hook ready; shell/pill renderer ready; audio-stream ready when startup policy prewarms it. Agent/MCP readiness is excluded and measured separately. “Cold” means process-cold, not filesystem-cache-cold. |
| First recording activation | `hotkey.detected` before session callback | later of `audio.capture.started` and `surface.paint-proxy(recording)` | `recording.begin.accepted`, target captured, audio request sent, renderer event received. Report rejected starts separately. |
| Settings-open latency | `surface.requested(settings)` before create/show/property changes | `surface.paint-proxy(settings)` after meaningful content and initial focus target exist | BrowserWindow constructed, `dom-ready`, `did-finish-load`, `ready-to-show`, React committed. Report cold-create and warm-show separately. |
| Agent-mode first-use latency | `agent.run.requested` when main accepts a fixed typed fixture and allocates the run ID | first semantic outcome: `agent.response.first-delta`, `approval.requested`, or terminal response | sidecar spawn/ready, config sent, MCP-ready barrier, provider request start. Do not use the immediate “Thinking” status as the end. Report cold-sidecar and warm-sidecar separately. |
| MCP first-tool latency | `agent.run.requested` for the deterministic one-tool fixture | `mcp.tool.execute.started` | sidecar ready, `mcp.connect.requested`, stdio child spawned or HTTP session created, `mcp.tools.discovered`, model tool request received. Also report connect-to-discovery and execute-start-to-result spans. |
| Transcription first-token latency | `audio.speech-onset` from the canonical real-time-paced PCM fixture | first non-empty tentative or stable transcript message received by the streaming owner | WS connect/open and first PCM send. Live-mic runs use hotkey-to-token as a supplemental measure because acoustic onset is not repeatable without VAD. |
| Stable-text commit latency | `audio.speech-onset` | first non-empty server-declared stable/committed delta received | stable delta queued, safe-target check, injection requested/completed. “Stable” comes from WhisperLiveKit, never from a client heuristic. |
| Final transcription latency | `recording.stop.requested` before flush | `recording.session.completed` after the final server message is reconciled and the last eligible delta is dispatched | flush sent, final message received, de-duplication complete. For batch providers, also report stop-to-batch-request and request-to-result. |
| UI transition latency | `ui.transition.requested(from,to)` before native window changes and renderer state dispatch | `surface.paint-proxy(to)` | native property changes complete and React commit. Required transitions: hidden→recording, recording→hidden, hidden→agent, agent→approval, hidden→settings, settings→overlay. |
| Idle memory and process count/type | start of the declared steady-state sample window | end of the window | per-process and grouped private bytes/working set plus BrowserWindow/webContents inventory. |
| WhisperLiveKit CPU/GPU/VRAM | start/end markers for idle or canonical utterance window | same | Docker container CPU/memory/PIDs; GPU total utilization/memory/power; compute-process VRAM where available; Docker Desktop/WSL host overhead separately. |

`surface.paint-proxy` means: state applied in a React layout effect, then two `requestAnimationFrame` callbacks, then IPC received by main. It is a repeatable “eligible to have painted” proxy, not proof that pixels reached the monitor. If a UI regression is disputed, capture Chromium `contentTracing` and a WPR/WPA trace with DWM frame details.

For streaming ASR, use a versioned PCM16LE/16-kHz/mono fixture with a known leading-silence duration and SHA-256. Pace 4096-sample chunks every 256 ms. The first-token and first-stable endpoints are measured from the fixture’s known speech-onset point, while final latency is measured from stop/flush. Store received stable/tentative lengths and hashes, not raw transcript text, in benchmark output.

## Process and resource attribution

Use `(PID, creationTime)` as process identity because PIDs are reusable.

- **Electron main:** `process.pid`.
- **Electron children:** `app.getAppMetrics()` supplies PID, creation time, type, service name/name, CPU, and memory. Map each WebContents to its OS renderer PID with `webContents.getOSProcessId()` and tag it with the semantic surface/route. Record BrowserWindow count separately from renderer-process count.
- **Agent sidecar:** record the child PID at spawn and its creation time. Group only that PID as `agent-sidecar`.
- **stdio MCP:** record the direct child PID and continuously retain its descendant tree as `mcp:<serverId>`. Intermediary launchers remain in the server group. A PID whose recorded creation precedes its alleged parent is not accepted as a descendant.
- **HTTP MCP:** attribute no local server process unless it is an explicitly managed-local process; report client cost inside the sidecar and remote latency separately.
- **WhisperLiveKit:** identify by immutable Docker container ID/image digest, never by display name alone.
- **Docker Desktop/WSL:** report `Docker Desktop`, `com.docker.*`, `wslhost`/`VmmemWSL` overhead as a separate host group. It is not added to Whisper’s container total. Controlled runs require no unrelated running containers.
- **NVIDIA:** record GPU UUID and driver version. Total device metrics are primary on Docker Desktop/WSL; per-compute-process VRAM is supplemental because process attribution can be unavailable or represented through WSL.

Primary application-memory score is the sum of Windows private bytes across Shuddhalekhan-owned processes. Also report working set by process and summed working set, explicitly labelled “non-unique” because shared pages can be counted more than once. Never compare Electron’s KB values without converting them to bytes first.

## Sampling

- Windows process topology, private bytes, working set, handle/thread count, and cumulative CPU: 1 Hz. Refresh the topology every sample. Derive CPU from cumulative CPU deltas; do not use the first delta.
- Electron `app.getAppMetrics()`: 1 Hz aligned with the external sample; discard its first CPU percentage sample because Electron documents it as zero.
- Docker container stats: 1 Hz, using the container stats stream/API. Retain raw CPU, memory, network, block I/O, and PID fields.
- NVIDIA: 1 Hz with `nvidia-smi --loop-ms=1000`; retain GPU UUID, utilization, memory used/total, power draw, temperature, and compute-app PID/name/used memory when supported.
- Latency: event markers only; polling samples must not define event endpoints.
- Default idle window: wait 60 seconds after `runtime.operational` and the scenario-specific ready barrier, then collect 60 samples over 60 seconds.
- Action resource window: 5 seconds before the trigger through 10 seconds after terminal completion. Peaks from 1 Hz are descriptive, not micro-peaks.
- WPR/ETW or Chromium tracing is collected only on a failed/noisy scenario and is never mixed into a normal timing sample.

## Scenario matrix and run protocol

All release-comparable results come from an installed packaged x64 build with DevTools closed. Development builds may be profiled but are labelled non-comparable. Record commit SHA, installer hash, Electron/Chromium/Node/Bun versions, Windows build, CPU/RAM, power mode, AC/battery state, GPU/driver, display refresh/DPI, audio device/driver, Docker Desktop/WSL versions, container image digest, Whisper model/backend/compute/language, and configuration hash.

Control the machine: AC power, fixed Windows power mode, no pending restart/update, fixed display topology, no unrelated containers, no foreground downloads/scans, and the same target app. Disable updater/network work for deterministic fixtures. Never purge OS caches. “Process-cold” is a fully terminated Shuddhalekhan tree for 15 seconds; “warm” retains the named runtime component. A first-after-reboot observation is optional and reported separately.

Required scenarios:

1. Dictation-only, Agent disabled: fresh startup idle; post-first-recording hidden idle; active recording.
2. Settings: first create/open and existing-window show; Settings open idle.
3. Agent enabled, no MCP: cold sidecar and warm sidecar.
4. One deterministic stdio MCP and one deterministic HTTP MCP, measured independently: cold connect/discovery, warm tool use, crash/reconnect in a non-gating resilience run.
5. WhisperLiveKit: container/model cold and warm; idle; canonical PCM streaming; REST/batch fallback.
6. UI state collisions relevant to the target architecture: Settings open while recording, agent response, and approval occur.

Run counts:

- Process-cold startup and cold sidecar/MCP/model: 20 measured repetitions per build. Fully tear down only the component named cold.
- Warm UI, recording, Agent, MCP, and ASR latencies: 3 warm-ups followed by 30 measured repetitions.
- Idle resources: 5 independent launches, each with the 60-second settle plus 60-second sample window.
- Live microphone/manual validation: 10 repetitions; report separately from deterministic fixtures.
- Interleave baseline and candidate in ABBA order where practical. Never run all baseline samples days before all candidate samples.
- A missing required marker, timeout, crash, focus loss, transcript-integrity failure, or unexpected background process invalidates that repetition and is reported as a failure count; it is not silently discarded. Warm-ups are the only routine exclusions.

## Reporting and regression rule

Keep raw artifacts immutable:

- `metadata.json`
- `events.jsonl`
- `process-samples.csv`
- `docker-samples.csv`
- `gpu-samples.csv`
- `summary.json` and `summary.md`
- optional `.etl` and Chromium trace files for escalations

For every latency report `n`, failures, p50, p95, maximum, and baseline-to-candidate delta. For idle resources report per-launch median, overall median, p95, maximum, and the process-group breakdown. Report process counts as exact inventories, not averages. Report CPU in both host percentage and normalized logical-core equivalents where the source permits it.

Before freezing budgets, run the same artifact as A/A and calculate a noise allowance per metric. The provisional regression allowance is:

- Process/BrowserWindow count: zero unapproved increase.
- Idle private bytes: `max(10 MiB, 5% of baseline, 3 × A/A MAD)`.
- Per-process-group private bytes: `max(5 MiB, 5%, 3 × A/A MAD)`.
- Local UI/recording latency: `max(16.7 ms, 10%, 3 × A/A MAD)`.
- Startup latency: `max(50 ms, 10%, 3 × A/A MAD)`.
- Agent/MCP/ASR latency: `max(100 ms, 10%, 3 × A/A MAD)`.
- Idle CPU: `max(2 host percentage points, 3 × A/A MAD)`.
- GPU VRAM: `max(128 MiB, 5%, 3 × A/A MAD)`.
- Container memory: `max(64 MiB, 5%, 3 × A/A MAD)`.

A candidate is a regression when either its p50 or p95 exceeds the corresponding baseline statistic by more than the allowance, provided the same direction appears in at least four of five independent launch groups. Process-count violations fail immediately. Product-approved tradeoffs must name the deliberately spent budget; they are not hidden by changing the baseline.

The renderer-consolidation effort must additionally prove the intended topology in the relevant steady states. This protocol does **not** pre-claim a memory percentage improvement: the achievable reduction is evidence the first baseline must establish.

## Harness usage

Build the Windows package before a release-comparable run. The runner defaults to `diagnostic-unverified`; pass the comparability label only after installing the x64 artifact and satisfying the machine controls above.

```powershell
cd app
bun run dist
bun run scripts/runtime-benchmark.ts run-abba `
  --baseline-exe 'C:\path\to\baseline\Shuddhalekhan.exe' `
  --candidate-exe 'C:\path\to\candidate\Shuddhalekhan.exe' `
  --scenario dictation-idle `
  --repetitions 20 `
  --comparability packaged-windows-x64 `
  --output '..\benchmark-output\startup-abba'
```

Each run gets an isolated artifact directory. `runtime-scenario-runner.ps1` owns the exact launched process tree, waits for `runtime.operational`, samples declared identities, and terminates only that tree. `runtime-benchmark.ts summarize --output <run-directory>` can regenerate a per-run summary. Local `benchmark-output/` is ignored. Keep raw per-run captures out of Git; publish them as an external issue or release attachment only when a review needs the complete capture set. Reviewed summaries and environment provenance may be tracked deliberately.

Action scenarios are driven only when both marker collection and `SHUDDHALEKHAN_PERF_DRIVER=1` are enabled by the runner. The driver ignores persisted Agent/MCP state, suppresses updater work, and uses only the local fixture services. Warm measurements can stay in one packaged process by passing `--warmup-repetitions 3 --action-repetitions 30`; warmup markers are tagged and excluded from summaries. Cold scenarios use one action per process launch.

For a managed local ASR service, pass `--transcription-endpoint <url>` and `--docker-container-id <immutable-id>` to route the pinned WAV through that packaged Dictation path while collecting the attributed container and GPU samples. Without the override, `dictation-recording` uses the deterministic local provider fixture.

The canonical spoken PCM and deterministic MCP servers are declared in `scripts/performance/fixtures/manifest.json`. Replacing the PCM requires an intentional `bun scripts/performance/generate-pcm-fixture.ts --regenerate`, audible review, and a manifest checksum update.

## Evidence status

The first packaged current-main baseline summary, A/A noise, process/window inventories, environment provenance, and provisional machine-specific allowances are published under `docs/performance/evidence/2026-08-13-d39acd2/`. Raw per-run captures remain local under ignored `benchmark-output/` and are reproducible through the harness.

Still open for later runtime work:

- The real memory reduction from renderer consolidation.
- Whether the two-rAF paint proxy tracks visible presentation closely enough on this hardware; use WPR/Chromium tracing to calibrate once.
- Streaming first-token and server-declared stable-text results after the runtime adopts the streaming WhisperLiveKit path. The current pre-migration app exposes only batch Dictation, so its baseline reports stop-to-batch-result.

## Primary references

- Electron: [`app.getAppMetrics()`](https://www.electronjs.org/docs/latest/api/app#appgetappmetrics), [ProcessMetric](https://www.electronjs.org/docs/latest/api/structures/process-metric), [MemoryInfo](https://www.electronjs.org/docs/latest/api/structures/memory-info), [process memory](https://www.electronjs.org/docs/latest/api/process#processgetprocessmemoryinfo), [renderer OS PID](https://www.electronjs.org/docs/latest/api/web-contents#contentsgetosprocessid), [content tracing](https://www.electronjs.org/docs/latest/api/content-tracing/), and [performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance).
- Microsoft: [QPC and high-resolution timestamps](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps), [Stopwatch](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.stopwatch), [Process V2 counter guidance](https://learn.microsoft.com/en-us/windows/win32/perfctrs/collecting-performance-data), [Windows memory counters](https://learn.microsoft.com/en-us/windows/win32/memory/memory-performance-information), and [WPR command line](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-command-line-options).
- Docker: [container stats](https://docs.docker.com/reference/cli/docker/container/stats/) and [runtime metrics](https://docs.docker.com/engine/containers/runmetrics/).
- NVIDIA: [nvidia-smi reference](https://docs.nvidia.com/deploy/nvidia-smi/index.html).
- Node.js: [performance measurement APIs](https://nodejs.org/api/perf_hooks.html).
