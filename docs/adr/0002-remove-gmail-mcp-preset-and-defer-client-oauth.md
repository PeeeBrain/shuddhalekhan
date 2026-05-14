# Remove Gmail MCP Preset and Keep Generic MCP OAuth

Shuddhalekhan v4 will remove the built-in Gmail MCP preset and the Gmail-shaped MCP-client OAuth flow. The previous preset depended on a first-party Gmail MCP endpoint that requires developer-program access, while the working path is to let users add their own hosted MCP servers through the generic HTTP/stdio registry. Generic MCP-client OAuth remains supported for protected hosted MCP servers: the server advertises authorization, Shuddhalekhan opens the server-provided authorization URL, stores tokens per MCP server, and sends bearer tokens through the AI SDK transport. Hosted MCP servers may still manage their own downstream service-specific OAuth internally.

**Consequences**

- The v4 MCP registry has no presets, templates, or bundled Gmail shortcut.
- HTTP MCP transport config does not persist OAuth client metadata.
- Connection-level OAuth support is generic rather than Gmail-specific.
