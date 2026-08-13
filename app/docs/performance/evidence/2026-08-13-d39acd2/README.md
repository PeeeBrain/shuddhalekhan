# Packaged runtime baseline summary — 2026-08-13

This is the first packaged-Windows runtime baseline for issue #176. It measures commit `d39acd2d10b1c19b85d5b6438a3b1ed2e7257776`, which is current `main` plus the opt-in measurement harness. Measurement is a default no-op; the packaged scenario driver requires both marker and driver gates.

The executable SHA-256 is `0c404b3d5cda4e046195897b51d7b7c948fc9d33dd02307895373fc6eac4dde6`. Every one of the 65 captured launches records that same commit and executable hash. The NSIS installer SHA-256 is recorded in `environment.json`.

## Validity

- Result label: `diagnostic-unverified` packaged Windows x64 baseline.
- Failures: zero missing markers, timeouts, crashes, or collector failures.
- Cold startup: 20 process-cold repetitions per identical A/A label, interleaved ABBA with a 15-second terminated interval.
- Warm scenarios: two independent ABBA launches per label; each launch used 3 warmups and 15 measured actions, for 30 measured actions per label.
- Idle: five independent launches; each used a 60-second settle and 60 samples at 1 Hz.
- WhisperLiveKit remained healthy and fixed to the immutable container/image identities in `environment.json`.
- The canonical pinned WAV produced non-empty text through the real packaged Dictation batch path. This is a latency baseline, not a transcription-quality assertion.

The label remains diagnostic because the packaged `win-unpacked` executable was used instead of an installed NSIS copy and the complete release-lab machine-control checklist was not independently certified. The results are reproducible and suitable for establishing the first local A/A noise envelope.

## Latency results

All durations are milliseconds. A and B are the same executable and therefore show A/A noise, not a product comparison.

| Scenario / metric | n per label | A p50 / p95 / max | B p50 / p95 / max | Max A/A MAD | Failures |
|---|---:|---:|---:|---:|---:|
| Process-cold startup | 20 | 516.35 / 545.98 / 576.89 | 506.15 / 560.46 / 563.71 | 14.19 | 0 |
| Warm Settings open | 30 | 8.00 / 8.13 / 16.09 | 7.98 / 8.29 / 8.38 | 0.10 | 0 |
| Warm Agent first outcome | 30 | 13.19 / 17.68 / 21.21 | 13.65 / 16.06 / 27.17 | 1.08 | 0 |
| Warm stdio MCP first tool | 30 | 13.40 / 15.73 / 21.50 | 14.11 / 16.90 / 19.50 | 1.24 | 0 |
| Warm stdio MCP execution | 30 | 1.97 / 3.15 / 6.48 | 2.00 / 2.72 / 2.90 | 0.38 | 0 |
| Warm HTTP MCP first tool | 30 | 12.08 / 14.46 / 15.21 | 13.52 / 15.73 / 29.60 | 1.46 | 0 |
| Warm HTTP MCP execution | 30 | 15.13 / 19.89 / 21.06 | 15.03 / 16.52 / 17.09 | 0.95 | 0 |
| Warm recording activation | 30 | 9.76 / 11.35 / 16.20 | 9.48 / 12.49 / 15.22 | 1.43 | 0 |
| WhisperLiveKit stop-to-batch-result | 30 | 1504.28 / 1600.92 / 1634.98 | 1489.09 / 1572.98 / 1625.58 | 28.95 | 0 |

Agent first outcome ends at the first semantic response delta. MCP connection/discovery occurs in the three warmups and is intentionally excluded from the warm tool-use distribution. Current Dictation is batch-only, so streaming first-token and server-declared stable-text endpoints are not applicable to this pre-migration runtime; the baseline reports stop-to-batch-result instead.

## Idle resources

The table reports each launch's median over its 60 samples.

| Launch | App private bytes | App host CPU | Container memory | Container CPU | GPU VRAM | GPU utilization |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 188.8 MiB | 1.14% | 1729.5 MiB | 0.22% | 1376 MiB | 0% |
| 2 | 187.5 MiB | 1.14% | 1730.6 MiB | 0.23% | 1376 MiB | 0% |
| 3 | 187.3 MiB | 1.18% | 1683.5 MiB | 0.23% | 1375 MiB | 0% |
| 4 | 190.5 MiB | 1.22% | 1683.5 MiB | 0.23% | 1375 MiB | 0% |
| 5 | 188.4 MiB | 1.10% | 1683.5 MiB | 0.21% | 1380 MiB | 0% |
| Median | 188.4 MiB | 1.14% | 1683.5 MiB | 0.23% | 1376 MiB | 0% |

The application memory score sums private bytes across the explicitly attributed Electron processes. Container memory and GPU VRAM are separate and are never added to the app score.

## Process and window inventories

- Dictation idle: 1 BrowserWindow; Electron main, GPU, utility, and renderer processes; exactly 4 attributed processes at every idle sample.
- Settings and recording: 2 BrowserWindows; Electron main, GPU, utility, and renderer roles.
- Agent without MCP: 2 BrowserWindows plus the Agent sidecar.
- stdio MCP: 2 BrowserWindows, Agent sidecar, and managed `mcp:benchmark-echo` descendants.
- HTTP MCP: 2 BrowserWindows and Agent sidecar; the fixture HTTP server is harness-managed and outside the app process score.

No inventory contains an unapproved app process or window increase within its declared scenario.

## Initial regression allowances

Applying the protocol's fixed floor, percentage, and three-times-MAD rules yields these first-machine allowances:

| Metric family | Allowance |
|---|---:|
| Startup latency | 51.6 ms |
| Local UI / recording activation | 16.7 ms |
| Agent / MCP latency | 100 ms |
| Batch ASR completion | 150.4 ms |
| App idle private bytes | 10 MiB |
| WhisperLiveKit idle memory | 84.2 MiB |
| App idle CPU | 2 host percentage points |
| GPU VRAM | 128 MiB |
| Process / BrowserWindow count | zero unapproved increase |

These are provisional machine-specific guardrails. A future candidate must still reproduce the direction in independent launch groups as required by the protocol.

## Evidence policy

This directory tracks the reviewed baseline summary and `environment.json`, which records package, machine, GPU, Docker, and WhisperLiveKit provenance. Per-run JSONL, CSV, metadata, and generated summaries are raw benchmark data and are intentionally not tracked in Git.

The local captures remain under ignored `benchmark-output/` and can be regenerated with the performance harness. Publish them as an external issue or release attachment if a future review needs the complete capture set.
