# AI SDK-native tool approval flow

Shuddhalekhan implements human-in-the-loop Agent Mode tool approval using the AI SDK-native `needsApproval`, `tool-approval-request`, and `tool-approval-response` flow rather than blocking inside MCP tool `execute()` handlers. The blocking wrapper was simpler locally, but it violated AI SDK semantics: approval denials must be returned to the model through message history and a resumed model call, which explains the observed bug where denying a tool request produced no follow-up provider request.

## Consequences

`mcp-registry.ts` exposes `alwaysAsk` tools with `needsApproval: true` and keeps execution wrapping only for audit/tool-status behavior. `runtime.ts` owns the per-run `ModelMessage[]`, appends AI SDK response messages, collects approval requests, prompts the user sequentially, appends the collected approval responses, and resumes `streamText`. User denial and approval timeout resume the active run with denied approval responses; interrupted runs such as replacement, shutdown, or stale cleanup abort without resuming the model.
