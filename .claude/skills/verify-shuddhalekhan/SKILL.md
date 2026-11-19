---
name: verify-shuddhalekhan
description: Launch the Shuddhalekhan desktop (Electron) dev app on Linux or Windows with the maintainer's real settings, and drive its Settings and runtime windows over Chrome DevTools Protocol to prove a change works the way a user sees it. Use when asked to verify, smoke-test, or screenshot a desktop UI/config/Agent Mode/MCP/Dictation change in the real app, not just in Bun tests.
---

# Verify Shuddhalekhan (desktop: Linux and Windows)

`sl.ts` starts the real app with `bun run dev`, with DevTools on port 9339. It drives the renderer pages over CDP and saves screenshots as evidence. All commands are `bun` and work the same on both platforms. Run them from the repo root:

```sh
S=.claude/skills/verify-shuddhalekhan/sl.ts    # PowerShell: $S = ".claude/skills/verify-shuddhalekhan/sl.ts"
```

AGENTS.md still applies. Launch only when the maintainer asked for a real-app pass. Subagents never launch their own instance.

## Config: real by default

The instance uses the maintainer's **real config**: `~/.config/Shuddhalekhan/` on Linux, `%APPDATA%\Shuddhalekhan\` on Windows. Their providers, API key env-var names, Agent Mode, MCP servers, skills, shortcuts, and audit history are all live. That is the point: Agent and Dictation journeys run against a setup that already works. It also means:

- **Leave the config the way you found it.** Before changing a setting, read it with `bun $S config <path>`, and set it back through the UI when you're done. `launch` saves a launch-time copy and `stop` reports `real config changed` if anything differs. Diff it and undo whatever you didn't mean to keep. Never edit the config file directly.
- **Agent runs are real.** Tool calls reach real MCP servers and land in the real audit history. Prefer read-only tools. Approve a tool with side effects only when the maintainer asked for exactly that.

**Read, don't assume.** This skill and its feature files deliberately name no configured values: no hotkeys, activation modes, providers, models, devices, servers, or on/off states. App defaults don't count either, because the maintainer may have changed any of them. Before a journey, read what is actually set and drive with that:

- `bun $S config <path>` reads stored values, before or after `launch`, for example `shortcuts`, `transcription.activeProvider`, `agent.enabled`, `agent.provider`, and `agent.mcpServers`. With no path it prints the config file location; read the file itself for anything else.
- The Settings page shows what the stored values mean. For example, `shortcuts` stores raw keycodes, and the Shortcuts section shows the chord a human presses. `bun $S eval settings "document.body.innerText"` on the relevant section is the readable source.
- If what you need is unset, such as a shortcut binding of `null`, no working provider, or Agent Mode off when the journey needs it on, say so and report the journey as blocked. Don't fall back to a default you know from the code, and don't change the setting unless the maintainer asked.

**Use a fresh config only when the task needs one**: first-run onboarding, migrating from defaults, or a setting combination you must not apply to the real config. Then launch with `SL_FRESH_CONFIG=1` (Linux only). This points `XDG_CONFIG_HOME` at a throwaway `.cache/verify-shuddhalekhan/run/config`, and `stop` deletes it. Don't use it just to avoid the cleanup above. On Windows, Electron reads the app-data folder from Windows itself and ignores `%APPDATA%`, so a fresh config would need an app change. Stop and ask the maintainer.

## Launch

```sh
bun $S launch      # prints: ready pid=<pid> port=9339 config=real settings=open|closed log=.cache/verify-shuddhalekhan/run/app.log
```

`launch` returns once the `runtime` surface has loaded, and reports whether Settings is open. Settings opens by itself only while onboarding is pending, which in practice means a fresh config. On the real config it reports `settings=closed`. Open it the way a user does, by opening the app again while it runs:

```sh
bun $S open-settings   # prints: settings open
```

This starts a second copy of the dev app. It loses the single-instance lock and quits, and the running instance shows Settings and focuses it. Run it again whenever Settings has been closed. The tray's `Settings…` is the other user path, but `sl.ts` cannot click it. If `open-settings` fails, report it as a product bug ("opening the app again did not show Settings"). Don't work around it. It **refuses** when the installed app or another dev instance is running. Both share the settings store, the global shortcuts, and Electron's single-instance lock, so a second instance would just quit. Ask the maintainer to quit the app from the tray. Never kill it yourself. Launch also refuses if an earlier `sl.ts` instance is alive, or if port 9339 is taken (set `SL_CDP_PORT` to use another port). The Vite renderer takes 5173, or the next free port.

Shortcuts use the desktop's normal backend: the portal on Linux Wayland, X11 grabs on X11, and the keyboard hook on Windows. Hotkeys pressed by a human therefore work like they do in the installed app.

## Doctor

```sh
bun $S doctor
```

This is read-only. It checks that the launched pid is alive and the CDP endpoint answers, and reports `config: real|fresh`, the config file path, and the open routes. `ok: true` with no `settings` route means the app is healthy but Settings is closed (see Launch). It is not a failure. A `FAIL` line means don't drive the instance. Run `stop`, then `launch`. Startup errors go to `.cache/verify-shuddhalekhan/run/app.log`.

## Drive

Pages are addressed by route: `settings` (the Settings window) and `runtime` (the hidden recording pill and toast surface; empty while idle).

| Command | Does |
|---|---|
| `bun $S open-settings` | Opens the app again so the running instance shows Settings. Use it when `targets` lists no `settings`. |
| `bun $S click settings "<name>"` | Clicks the visible button, link, tab, switch, etc. whose `aria-label` or exact text is `<name>`. Controls inside an open dialog win, so `Remove`/`Disable` confirm the dialog. |
| `bun $S fill settings "<label>" <value>` | Sets an input found by `aria-label`, placeholder, or `<label>` text the way React sees typing, then blurs it. Text fields save on blur. |
| `bun $S wait settings "<text>" [ms]` | Polls until `<text>` appears in `document.body.innerText`. Use it instead of sleeps. |
| `bun $S eval settings '<js>'` | Read-only DOM queries such as `aria-checked`. Never call `window.api`/IPC to change state: that skips the user path. |
| `bun $S shot settings <name>` | Saves `.cache/verify-shuddhalekhan/evidence/<name>.png`. |
| `bun $S config agent.enabled` | Prints a value from the config file in use. With no path, it prints the file path. |
| `bun $S sidecar` | Prints how many Agent Mode sidecar processes are running (`bun …/app/src/agent/index.ts`). |

Sidebar sections are buttons named `Home`, `Transcription`, `Shortcuts`, `Agent`, `MCP Servers`, `Computer Use`, `Plugins`, `Skills`, `Memory`, `History`, `About`. A fresh config hides them behind onboarding until you `click settings "Configure an advanced provider"`.

To find handles on a new screen, list the controls:

```sh
bun $S eval settings "[...document.querySelectorAll('button,input,textarea,[role=switch],[role=combobox]')].filter(e=>e.checkVisibility()).map(e=>(e.getAttribute('role')||e.type)+'|'+(e.getAttribute('aria-label')||[...(e.labels??[])].map(l=>l.textContent.trim()).join('/')||e.textContent.trim()))"
```

Out of reach for `sl.ts`: the tray menu (native; use `open-settings` for Settings), global hotkeys, the microphone, and text injection into another app. Journeys that need them are human-assisted (see [dictation](features/dictation.md)). Report them as unverified unless the maintainer did the step.

## Evidence

Proof standards:

- Drive the real user path: clicks and fills in the UI, not IPC calls or config-file edits.
- Capture the action and the resulting state: a screenshot of the dialog or toast, plus the state after it.
- Check side effects from a second view as well as the screen: `bun $S config …` for persisted settings, `bun $S sidecar` for the sidecar process, History in Settings for audit rows.
- Mocks only where a production boundary already isolates the external system.
- A feature file can list several entry points. Proving one does not verify the others; say which you used.
- Say which platform you ran on. A Linux pass does not verify Windows, and the reverse is also true.

Screenshots go to `.cache/verify-shuddhalekhan/evidence/` (git-ignored). They can show real settings, such as MCP server names, so check them before attaching one to a PR with `gh pr edit --attach`. Don't commit them.

## Cleanup

```sh
bun $S stop
```

Linux: `stop` sends SIGTERM to the process group `launch` created, so the app's normal quit cleanup runs, and escalates to SIGKILL after 10s. Windows: it runs `taskkill /T /F` on the process tree under the `bun` it spawned. That skips the app's quit cleanup, which is fine because SQLite's WAL survives it. On both, it then waits until no Shuddhalekhan Electron helper is left. That's safe because `launch` refused to start beside another instance. It never kills by name.

`stop` then lists each real-config path that changed, or prints `real config unchanged`. It ignores MCP `discoveredAt`/`discoveredTools`, because the app rewrites those itself whenever a server connects. It then deletes `run/`, including a fresh config. It keeps `evidence/` and the launch-time config copy. Run it after every failed attempt too. Clear stale evidence yourself with `rm -r .cache/verify-shuddhalekhan/evidence` before a new proof.

## Feature map

[`features/README.md`](features/README.md) indexes the user-facing features and their journeys. Read the matching file before driving. When a journey is wrong because the app changed, fix the map in the same change.
