# Use the ChatGPT Plan Through the Existing AI SDK Runtime

Agent Mode can run on a user's ChatGPT Plus or Pro plan through Sign in with ChatGPT (SIWC). Electron main runs the OAuth flow itself: a loopback callback, PKCE, dynamic client registration, and ID-token verification with Node `crypto`. Tokens are stored in the safeStorage credential vault and given to the sidecar only per run. The sidecar keeps its Vercel AI SDK loop and calls `https://api.openai.com/v1/responses` with the plan's bearer token, using the restrictions SIWC requires: streaming only, `store: false`, developer messages instead of system messages, and no sampling or metadata parameters. We rejected the Codex App Server as the agent runtime. It would replace our tool loop, MCP registry, approval toasts, and audit log with a second agent harness that has its own configuration, sandbox, and update cadence. It would also tie Agent Mode to a Codex CLI install. This conflicts with the single-flight, provider-agnostic sidecar described in ADR 0001.

**Consequences**

- `chatgpt` is one more provider kind. MCP, approvals, audit, and Dictation are unchanged.
- There is no API-key or billing fallback for the ChatGPT provider. If the user did not grant the `chatgpt.tokens.use.direct` permission, the provider reports missing credentials.
- We do not use the SIWC devkit because of its noncommercial license, so we own the OAuth code and its tests.
- Revisit the Codex App Server if SIWC stops allowing direct Responses calls, or if users ask for Codex-specific features such as its sandboxed shell or cloud tasks.
