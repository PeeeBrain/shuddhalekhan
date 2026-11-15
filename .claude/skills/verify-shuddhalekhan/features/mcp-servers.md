# MCP servers

Users add MCP servers in Settings so Agent Mode can call their tools. A server is saved to config, listed with its status, and can be edited, reconnected, or removed after a confirmation that warns its tool policies will be lost.

## Sub-features

- `mcp-add-stdio` saves a stdio server with a name, command, and arguments.
- `mcp-add-cancel` discards the add form.
- `mcp-list` shows the saved server with `Reconnect`, `Edit`, and `Remove`.
- `mcp-remove` asks for confirmation, then deletes the server from config.
- `mcp-discover` connects and lists tools. On the real config, the maintainer's servers already prove it: check MCP Servers shows their tools.

## How to get to it (user POV)

- Settings → `MCP Servers` → `Add server`.
- Installing a plugin (Settings → `Plugins`) also adds its remote servers. This entry is not covered here.

## Driving it with sl.ts

Preconditions:

- Launched on the real config, and `doctor` is ok.
- Record `bun $S config agent.mcpServers`. There is no server named `verify-stdio`.

- **Open form.** Run `bun $S click settings "MCP Servers"`, then `bun $S click settings "Add server"`. An inline `Add MCP Server` form appears. Read the `Transport` combobox and confirm it shows stdio, which is what this journey needs. If it doesn't, pick stdio first. Then confirm `Command`, `Arguments`, and `Environment variable names` are visible.
- **Fill.** Run `bun $S fill settings Name verify-stdio`, `bun $S fill settings Command bun`, and `bun $S fill settings Arguments --version`.
- **Save.** Run `bun $S click settings "Save Server"`, then `bun $S wait settings "verify-stdio"`. `bun $S config agent.mcpServers` gains one entry with `displayName: "verify-stdio"` and `transport.args: ["--version"]`. Run `bun $S shot settings mcp-saved`.
- **Remove.** Run `bun $S click settings Remove`, then `bun $S wait settings 'Remove "verify-stdio"?'`, then `bun $S click settings Remove` again. The second click hits the dialog's button. `config agent.mcpServers` matches the recorded value again, and `stop` prints `real config unchanged`.

## Gotchas

- `click settings Remove` picks the first visible `Remove`. With real servers listed, that can be the maintainer's server. The dialog names the server, so check that it says `"verify-stdio"` before confirming. Otherwise `Cancel` and scope with `eval`.
- `bun --version` is not an MCP server. Whether it tries to connect depends on `agent.enabled` and the form's `Enabled for Agent Mode` switch, so read both instead of predicting. A connection error is expected; assert persistence only.
- The add form is inline, not a dialog. `Arguments` is split on whitespace into `args`.
