# Shuddhalekhan desktop verification map

This directory holds the maintained recipes for verifying what users see in the Shuddhalekhan desktop app on Linux and Windows. Read this index first, then use the matching feature file as the recipe.

## Baseline preconditions

- The installed app is quit (`launch` refuses otherwise).
- Launch with `bun $S launch` from the repo root, using the real config unless the feature file says `SL_FRESH_CONFIG=1`.
- `bun $S doctor` reports `ok: true` and the expected `config` mode.
- Settings journeys need a `settings` route. On the real config it starts closed, so run `bun $S open-settings` first (see SKILL.md, Launch).
- Never drive an instance this run did not start.

## Driving conventions

- `S=.claude/skills/verify-shuddhalekhan/sl.ts`. Every command is `bun $S …` on both platforms. Use `bun $S config` and `bun $S sidecar` for side effects, not `jq`/`pstree`.
- Read what is configured (shortcuts, providers, Agent Mode, servers, device) with `bun $S config` and the Settings page before acting. Recipes name UI handles, never configured values or app defaults (see SKILL.md, "Read, don't assume").
- Address controls by `aria-label` or visible text, never by DOM position.
- Use `wait` for state changes, not `sleep`. Config writes land within about a second of the click or blur.
- Real config: record each value before you change it and set it back through the UI before `stop`. `stop` must print `real config unchanged`, or you explain the difference.

## Proof and skip reporting

- UI proof: a screenshot from `bun $S shot`, plus the `eval`/`wait` output naming the state.
- Mutation proof: a second view of the effect, from `bun $S config …` or `bun $S sidecar`.
- Record the feature ID, entry point, platform, and config mode with every artifact.
- Hotkey, tray, microphone, and text-injection steps need a human. If no human did them, report them as **not exercised** and never as verified through another path.

## Feature entry contract

Each file has an H1 and one paragraph, then four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with sl.ts`, `Gotchas`. The driving section starts with `Preconditions:`.

## Features

- [Agent Mode toggle](./agent-mode-toggle.md): enable and disable Agent Mode, with the sidecar starting and stopping. Real config; ends at the starting value.
- [MCP servers](./mcp-servers.md): add, persist, and remove a throwaway MCP server. Real config.
- [Dictation](./dictation.md): hotkey → recording pill → transcript → paste. Real config, human-assisted.
- [Onboarding](./onboarding.md): the first-run setup screen. Needs `SL_FRESH_CONFIG=1`, so Linux only.
