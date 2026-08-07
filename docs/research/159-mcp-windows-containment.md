# MCP headlessness and Windows containment research

Research for [Guarantee headless local MCP security and Windows process-tree containment](https://github.com/PeeeBrain/shuddhalekhan/issues/159), against `main` and installed `@ai-sdk/mcp@2.0.10`.

## Decision

Keep logical MCP ownership in the agent sidecar, but make Electron main the **enforcement owner** of one Windows Job Object per sidecar generation. The job must use `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, allow no breakaway, and contain the sidecar before main sends any config that can launch MCPs. All sidecar descendants then inherit the job.

Replace the AI SDK experimental stdio transport with a small Shuddhalekhan-owned `ManagedStdioMcpTransport` adapter. Continue using `createMCPClient`; own only process launch/stdio/lifecycle. The adapter must force `windowsHide: true`, `shell: false`, pipe all stdio, expose lifecycle/PID, capture bounded stderr, and implement MCP's graceful shutdown order: end stdin, wait, force the direct process after a timeout. Job teardown is the final process-tree backstop.

Do not move the sidecar to `utilityProcess` for containment. Electron's utility process has crash reporting and a service name, but its documented stdio modes do not support piped stdin, and `kill()` is not a Windows descendant-tree ownership primitive. A boundary change would therefore require a new parent-port protocol without solving the Job Object requirement.

For the first low-risk implementation, recycle the whole sidecar generation (close/terminate its job, then reconnect enabled servers) when a stdio server crashes or cannot be proved cleanly stopped. This trades a brief all-server reconnect for no orphan ambiguity. A per-server nested job can come later only with race-free launch (native `CREATE_SUSPENDED` + assign + resume, or an already-contained bootstrap supervisor); assigning a normally started process after spawn leaves an avoidable early-grandchild race.

## Guarantee and threat model

This design guarantees cleanup for trusted/cooperative or buggy MCP programs and descendants created through ordinary Win32 process inheritance:

- normal app exit;
- Agent Mode disable;
- sidecar crash or Task Manager termination;
- Electron main crash/forced termination (the OS closes main's last job handle);
- direct MCP crash followed by generation recycle;
- ordinary and detached descendants that remain in the job.

It is **not a sandbox for hostile local code**. An enabled stdio MCP executes with the user's token, filesystem and network access. Microsoft documents that children inherit a job by default, but also that processes created through `Win32_Process.Create` are not associated; deliberately hostile code has other same-user escape/exfiltration paths. `windowsHide` hides the initial console, not arbitrary GUI windows a server creates later. Tool approval governs whether the model invokes tools; it does not make the already-running server untrusted-code-safe. A hostile-server threat model would require a restricted token/AppContainer/Windows Sandbox/container design outside this refactor.

## Current repository findings

- `app/src/main/jsonl-process-manager.ts` hides the **sidecar** with `windowsHide: true`, but `stop()` immediately calls `child.kill()`, clears its reference, and does not await exit.
- On Windows, Node documents that supported “signals” kill abruptly. Consequently the sidecar's `SIGTERM` handler in `app/src/agent/index.ts` is not a graceful path when main calls `kill()`; `mcpRegistry.close()` and audit shutdown can be skipped.
- `AgentSidecarManager` does not currently subscribe to `JsonlProcessManager.onExit`, so a sidecar crash is not tied to descendant cleanup or restart status.
- The sidecar does have a correct async cleanup unit: abort active run, reject approval, close the MCP registry, close audit storage. It needs an explicit JSONL `sidecar:shutdown` / `sidecar:shutdown-complete` handshake.
- Enabled servers connect on each config update and `McpRegistry.disconnect()` awaits `client.close()`. The missing guarantee is below that seam.
- `@ai-sdk/mcp@2.0.10` launches with `windowsHide: process.platform === "win32" && ("type" in process)`. Direct probes found `process.type` absent in Bun 1.3.14 and Electron 43.1.0 under `ELECTRON_RUN_AS_NODE`; current stdio MCPs therefore use Node's default `windowsHide: false` in both supported sidecar modes.
- Its transport defaults stderr to `inherit`; MCP stderr flows into sidecar stderr, then `JsonlProcessManager` writes the raw chunk through Electron logging. This is unbounded and unredacted.
- Its `close()` aborts the spawn signal and forgets the process. It does not first close stdin and wait as the MCP lifecycle specifies.
- A controlled `@ai-sdk/mcp` close killed the direct Node child but left a deliberately detached grandchild alive. A controlled Job Object with `KILL_ON_JOB_CLOSE` killed both.
- Koffi successfully called `CreateJobObjectW` / `CloseHandle` in both Bun and Electron-as-Node, so the existing native dependency is a feasible implementation seam.

Primary behavior references: [Node child processes](https://nodejs.org/api/child_process.html), [MCP lifecycle](https://modelcontextprotocol.io/specification/2024-11-05/basic/lifecycle), [MCP stdio transport](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports), [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject), and [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process).

## Required launch and shutdown protocol

1. Main creates a fresh unnamed job and sets `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; do not set either breakaway flag.
2. Main starts the sidecar with `windowsHide: true` and a sanitized environment.
3. On the sidecar's OS `spawn` event, main assigns its process handle to the job. Assignment failure is fail-closed: send no config, terminate the child, report Agent runtime unavailable.
4. Only after assignment and `sidecar:ready` may main send config/secrets. This preserves the codebase invariant that the sidecar launches no MCP before config, eliminating the sidecar-assignment race.
5. On graceful stop, main sends `sidecar:shutdown`. Sidecar rejects new work, aborts the active run, records interruption, closes clients (stdin EOF → bounded wait → force direct process), closes redirects/audit, then acknowledges.
6. Main waits a bounded total duration, then terminates/ closes the job whether or not it received the acknowledgement. Electron quit orchestration must actually await this bounded phase; crash safety still comes from handle close.
7. On any sidecar exit, main immediately terminates/closes that generation's job before deciding whether to restart. Old-generation events are ignored.
8. On unexpected stdio close or a requested stdio restart/disable, use graceful close first; if complete tree cleanup is not independently provable, recycle the generation.

The exact graceful and hard-stop durations are implementation tunables to verify with representative Node, Python and WSL servers; the ordering is resolved.

## Environment and secrets

The installed AI SDK already starts from a limited Windows baseline plus only configured `envVarNames`, which is safer than full inheritance. However, `agent-sidecar.ts` itself currently receives all of `process.env`. Change the boundary so main resolves ambient environment references and stored credentials, then sends only the values required for the model and enabled MCPs over the private JSONL pipe. Launch the sidecar with a fixed OS/runtime baseline plus Shuddhalekhan paths, not `...process.env`.

Model MCP environment entries as value sources:

- ambient environment variable reference (migrates current `envVarNames`);
- encrypted stored secret reference;
- literal non-secret value.

Never persist secret values in `AppConfig`, command arguments, status, audit, or logs. Reuse the existing `CredentialVault`/Electron `safeStorage` with server-ID-and-variable scoped keys instead of introducing Windows Credential Manager solely for MCP. On Windows, Electron documents that `safeStorage` uses DPAPI; this is at-rest protection bound to the Windows user/machine, not isolation from another process already running as that user. Prefer absolute command/cwd and preserve an argument array with `shell: false`.

Reference: [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

## Stderr and diagnostics

Pass `stderr: "pipe"` explicitly. Consume it continuously so a full pipe cannot deadlock the server. Keep a bounded, rate-limited, per-server ring buffer in memory; redact registered secret values and known secret-shaped fields before emitting a short status/diagnostic. Do not persist raw stderr or add it to agent audit. Truncate malformed stdout/errors without echoing entire raw protocol lines. An explicit developer diagnostic mode may write sanitized per-server logs with size/retention limits.

## WSL

On this machine, assigning `wsl.exe -d Ubuntu -- ...` to the kill-on-close job terminated both a foreground Linux process and a `setsid` daemon probe when the Windows proxy was killed. Microsoft documents `wsl --shutdown` and `wsl --terminate <distro>`, but does not document Windows Job Objects as a Linux process-tree containment contract.

Therefore WSL commands remain supported for development/compatibility but must be labeled best-effort, not covered by the strong containment claim, until an in-distro supervisor is specified and regression-tested. Never invoke `wsl --shutdown` or `--terminate` automatically: either can kill unrelated user workloads in the shared distro/VM.

Reference: [Microsoft WSL commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands).

## Acceptance tests before shipping

- No console flashes for stdio launch in Bun dev and packaged Electron-as-Node.
- Sidecar cannot receive MCP-launch config until successful job assignment.
- Normal quit, disable, sidecar crash, main forced kill, MCP crash, and hung shutdown leave zero tagged Windows descendants.
- A detached Windows grandchild dies on generation teardown.
- Graceful test servers observe stdin EOF before force termination.
- Secret can reach exactly its configured MCP environment and does not appear in config, audit, stderr diagnostics, process arguments, or unrelated MCP environments.
- A server flooding stderr cannot grow memory without bound or block protocol traffic.
- Assignment/Job API failures are fail-closed and user-visible.
- WSL compatibility tests are separate and do not claim the Windows guarantee.

## Unverified edge, deliberately bounded

Packaged NSIS behavior should be rerun on a signed/release-equivalent build because this research used the installed Electron binary with `ELECTRON_RUN_AS_NODE`, not a packaged artifact. WSL proxy-to-Linux teardown is observed behavior, not a documented guarantee. Neither uncertainty changes the selected architecture: explicit `windowsHide`, fail-closed job assignment, generation cleanup, and a WSL best-effort boundary.
