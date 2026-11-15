# Agent Mode toggle

Users turn Agent Mode on in Settings, which starts the agent sidecar, and turn it off through a confirmation, which stops the sidecar and closes MCP connections. Dictation-only users never need it on.

## Sub-features

- `agent-enable` turns Agent Mode on, persists `agent.enabled: true`, and starts the sidecar.
- `agent-disable-confirm` asks before disabling and warns that runs are cancelled and MCP connections closed.
- `agent-disable` persists `agent.enabled: false` and the sidecar exits.
- `agent-disable-cancel` leaves Agent Mode on.

## How to get to it (user POV)

- Settings → `Agent` → the `Enable Agent Mode` switch.
- Settings → `Home` → the `Agent Mode` readiness row, which leads to the same section.

## Driving it with sl.ts

Preconditions:

- Launched on the real config, and `doctor` is ok.
- Record the starting state: `bun $S config agent.enabled` and `bun $S sidecar`. They agree: `true` with 1, or `false` with 0. On a fresh config, first `bun $S click settings "Configure an advanced provider"`.
- If the starting value is `true`, run **Disable** first and then **Enable**. Either way, end at the starting value.

- **Open section.** Run `bun $S click settings Agent`, then `bun $S wait settings "Speak a command, and an agent runs it once"`.
- **Enable.** Run `bun $S click settings "Enable Agent Mode"`. Within about 3s, `bun $S config agent.enabled` prints `true` and `bun $S sidecar` prints `1`.
- **Ask to disable.** Run `bun $S click settings "Enable Agent Mode"`, then `bun $S wait settings "Disable Agent Mode?"`, then `bun $S shot settings agent-disable-confirm`. The config still says `true`.
- **Cancel.** Run `bun $S click settings Cancel`. The switch's `aria-checked` stays `"true"` and `sidecar` still prints `1`.
- **Disable.** Repeat the ask step, then run `bun $S click settings Disable`. Within about 3s, `config agent.enabled` prints `false` and `sidecar` prints `0`.
- **Proof.** Keep the confirmation screenshot and the before and after `config`/`sidecar` output. `stop` prints `real config unchanged`.

## Gotchas

- A second click on the switch does not disable Agent Mode by itself. It opens the confirmation dialog. Asserting right after the click falsely reports "disable is broken".
- Disabling on the real config closes the maintainer's MCP connections. Re-enabling reconnects them; wait for MCP Servers to settle before `stop`.
- The sidecar starts even with no valid provider. Enabling proves process lifecycle, not that a model is reachable. `Test model` proves the provider.
