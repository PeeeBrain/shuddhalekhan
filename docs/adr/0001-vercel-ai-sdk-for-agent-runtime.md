# Vercel AI SDK for Agent Runtime

Shuddhalekhan v4 Agent Mode will use Vercel AI SDK with `@ai-sdk/mcp` inside the sidecar process. This keeps the runtime TypeScript-first and provider-agnostic while letting Shuddhalekhan own the important product boundaries: MCP server registry, per-tool approval policy, approval UI, post-tool audit events, and race-safe communication with Electron.

**Considered Options**

- Vercel AI SDK: chosen for the best balance of developer experience, iteration speed, and maintainability.
- VoltAgent and Mastra: credible TypeScript agent frameworks, but more opinionated than needed for the first MCP-backed Agent Mode.
- LangGraph.js: strongest durable human-in-the-loop model, but heavier than v1 requires.
- OpenAI Agents SDK JS: strong MCP and approval support, but less aligned with provider-agnostic local/cloud selection.
- TanStack AI and Cursor SDK: promising, but not yet a better fit for Shuddhalekhan's MCP-heavy personal workflow agent.
