import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, type JSONValue, type Tool } from "ai";
import type { AppConfig } from "../types/ipc";
import { logSidecar } from "./protocol";

export interface AgentRuntimeCallbacks {
  onStatus(status: string): void;
  onToolStarted?(tool: {
    serverId: string;
    toolName: string;
    modelToolName: string;
  }): void;
  onResponseDelta(textDelta: string, fullText: string): void;
  onCompleted(response: string, toolSummary: string[]): void;
  onFailed(error: string): void;
  onCancelled(): void;
  requestToolApproval(
    request: ToolApprovalRequest,
  ): Promise<ToolApprovalDecision>;
  onAudit?(eventType: string, payload?: Record<string, unknown>): void;
}

export interface ToolApprovalRequest {
  serverId: string;
  toolName: string;
  modelToolName: string;
  arguments: unknown;
}

export type ToolApprovalDecision =
  | {
      approved: true;
    }
  | {
      approved: false;
      message: string;
    };

const SYSTEM_PROMPT = `<identity>
You are Shuddhalekhan Agent, a concise voice-controlled assistant for short, one-off tasks.
</identity>

<persistence>
- Keep going until the user's request is resolved or a stop condition is reached.
- Do not ask clarifying questions when a reasonable assumption is available; proceed and state the assumption briefly in the final response.
- Stop and hand back to the user when the request requires missing credentials, an unavailable tool, an approval denial, or an unsafe/destructive action that was not explicitly requested.
</persistence>

<context_gathering>
Goal: Get enough context fast, then act.
- Use tools when the request depends on current, recent, external, online, web, search, news, factual lookup, URL-specific information, or an external/local integration.
- Do not use tools for stable knowledge, casual conversation, or requests answerable from the user's message alone.
- Avoid tangential exploration. Prefer one focused tool attempt; use additional tool calls only when the first result is incomplete, conflicting, or required to finish the task.
- If no suitable tool is available or no tool was called for a requested lookup/action, say that plainly.
</context_gathering>

<tool_preambles>
- Before tool use, briefly state what you are checking or doing.
- Keep tool preambles short because this is a voice-first workflow.
- After tool work, summarize the result and any user-relevant next step.
</tool_preambles>

<approval_handling>
- Respect tool policies and approval decisions exactly.
- If a tool result says exactly "Rejected: tool approval window expired.", stop execution and say the request stopped because tool approval expired.
- Do not mention deliberate focus unless that exact timeout rejection was received from a tool.
- If approval is denied or unavailable, do not retry the same action; explain the limitation briefly.
</approval_handling>

<response_style>
- Be concise, factual, and calm.
- Prefer one short paragraph or a few bullets.
- Do not expose hidden reasoning. Provide conclusions, key facts, assumptions, and caveats only when useful.
- Do not claim a tool action succeeded unless a tool result confirms it.
</response_style>`;

function buildSystemPrompt(now = new Date()): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localDateTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);

  return `${SYSTEM_PROMPT}

<runtime_context>
- Current local datetime: ${localDateTime}
- Current UTC datetime: ${now.toISOString()}
- Time zone: ${timeZone}
- Use this datetime context when interpreting relative dates like today, tomorrow, yesterday, tonight, this week, current year, or latest.
</runtime_context>`;
}

function getApiKey(envVarName: string): string | undefined {
  return process.env[envVarName];
}

function requiresApiKey(baseUrl: string): boolean {
  const parsed = new URL(baseUrl);
  const hostname = parsed.hostname.toLowerCase();
  return !["localhost", "127.0.0.1", "::1"].includes(hostname);
}

function looksLikeRawApiKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_-]/.test(value.trim());
}

function getProviderHeaders(
  baseUrl: string,
): Record<string, string> | undefined {
  if (!baseUrl.includes("openrouter.ai")) return undefined;

  return {
    "HTTP-Referer": "https://github.com/parthashirolkar/shuddhalekhan",
    "X-OpenRouter-Title": "Shuddhalekhan",
  };
}

function applyDefaultReasoningOptions(
  args: Record<string, unknown>,
  thinkingEnabled: boolean,
): Record<string, unknown> {
  if (!thinkingEnabled) return args;

  return {
    ...args,
    reasoning: {
      ...(typeof args.reasoning === "object" && args.reasoning !== null
        ? args.reasoning
        : {}),
      effort: "on",
    },
  };
}

type AgentProviderOptions = Record<string, Record<string, JSONValue>>;

function getDefaultProviderOptions(): AgentProviderOptions {
  return {};
}

function formatProviderError(err: unknown): string {
  const messages = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;

    if (typeof record.message === "string") {
      messages.add(record.message);
    }

    const statusCode = record.statusCode ?? record.status;
    if (typeof statusCode === "number") {
      messages.add(`HTTP ${statusCode}`);
    }

    if (record.responseBody) {
      messages.add(`Response: ${stringifyForMessage(record.responseBody)}`);
    }

    if (record.data) {
      messages.add(`Details: ${stringifyForMessage(record.data)}`);
    }

    if (record.cause && record.cause !== value) {
      visit(record.cause);
    }
  };

  visit(err);

  if (messages.size === 0) {
    return err instanceof Error ? err.message : String(err);
  }

  return Array.from(messages).join(" | ");
}

function stringifyForMessage(value: unknown): string {
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeFinalResponse(
  response: string,
  toolSummary: string[],
  callbacks: AgentRuntimeCallbacks,
): string {
  if (response.trim()) return response;

  const hadToolActivity = toolSummary.length > 0;
  callbacks.onAudit?.("empty_response_degraded", {
    toolSummary,
    hadToolActivity,
  });

  return hadToolActivity
    ? "The agent completed tool work but returned no final text."
    : "The agent completed, but returned an empty response.";
}

export async function runAgent(
  _agentRunId: string,
  transcript: string,
  config: AppConfig,
  tools: Record<string, Tool>,
  signal: AbortSignal,
  callbacks: AgentRuntimeCallbacks,
): Promise<void> {
  try {
    callbacks.onAudit?.("run_started", {
      transcript,
      modelVisibleMessages: [{ role: "user", content: transcript }],
      toolNames: Object.keys(tools),
    });

    const provider = config.agent.provider;
    if (!provider.baseUrl || !provider.model) {
      callbacks.onFailed(
        "Agent provider configuration is incomplete. Check base URL and model in Settings.",
      );
      return;
    }

    let apiKey = "shuddhalekhan-local-provider";
    if (requiresApiKey(provider.baseUrl)) {
      if (!provider.apiKeyEnvVar) {
        callbacks.onFailed(
          "Agent provider configuration is incomplete. Remote providers require an API key environment variable in Settings.",
        );
        return;
      }

      apiKey = getApiKey(provider.apiKeyEnvVar) ?? "";
      if (!apiKey) {
        if (looksLikeRawApiKey(provider.apiKeyEnvVar)) {
          callbacks.onFailed(
            "Settings contains an API key value, but Shuddhalekhan expects an environment variable name. Set OPENROUTER_API_KEY in your shell, restart bun run dev, and put OPENROUTER_API_KEY in Settings.",
          );
          return;
        }

        callbacks.onFailed(
          `API key environment variable "${provider.apiKeyEnvVar}" is not set.`,
        );
        return;
      }
    } else if (provider.apiKeyEnvVar) {
      if (looksLikeRawApiKey(provider.apiKeyEnvVar)) {
        callbacks.onFailed(
          "Settings contains an API key value, but Shuddhalekhan expects an environment variable name. Leave this field empty for local providers, or enter an environment variable name.",
        );
        return;
      }

      apiKey = getApiKey(provider.apiKeyEnvVar) ?? apiKey;
    }

    callbacks.onStatus("Connecting to tools...");

    const model = createOpenAICompatible({
      name: "shuddhalekhan",
      baseURL: provider.baseUrl,
      apiKey,
      headers: getProviderHeaders(provider.baseUrl),
      transformRequestBody: (args) =>
        applyDefaultReasoningOptions(args, provider.thinkingEnabled ?? true),
    }).chatModel(provider.model);

    callbacks.onStatus("Thinking...");

    const systemPrompt = buildSystemPrompt();
    let streamedResponse = "";
    const result = streamText({
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: transcript }],
      tools,
      providerOptions: getDefaultProviderOptions(),
      stopWhen: stepCountIs(5),
      abortSignal: signal,
      onChunk: ({ chunk }) => {
        if (chunk.type !== "text-delta") return;
        if (!streamedResponse && !chunk.text.trim()) return;
        streamedResponse += chunk.text;
        callbacks.onResponseDelta(chunk.text, streamedResponse);
      },
      onStepFinish: ({ toolCalls }) => {
        if (toolCalls.length > 0) {
          const names = toolCalls.map((t) => String(t.toolName)).join(", ");
          callbacks.onAudit?.("tool_requests", { toolCalls });
          callbacks.onStatus(`Using tools: ${names}`);
        } else {
          callbacks.onStatus("Thinking...");
        }
      },
    });

    let finalResponse = await result.text;
    if (!streamedResponse && finalResponse) {
      callbacks.onResponseDelta(finalResponse, finalResponse);
    }
    const toolSummary: string[] = [];
    const steps = await result.steps;
    const toolCalls = await result.toolCalls;
    const toolResults = await result.toolResults;

    for (const step of steps) {
      for (const tc of step.toolCalls) {
        toolSummary.push(`Used ${String(tc.toolName)}`);
      }
      if (step.toolResults.length > 0) {
        callbacks.onAudit?.("tool_results", { toolResults: step.toolResults });
      }
    }

    const reachedMaxSteps = steps.length >= 5;
    const hasPendingToolCalls = toolCalls.length > toolResults.length;

    if (reachedMaxSteps && hasPendingToolCalls) {
      callbacks.onStatus("Step limit reached. Summarizing...");
      let fallbackResponse = "";
      const fallback = streamText({
        model,
        system: systemPrompt,
        messages: [
          { role: "user", content: transcript },
          {
            role: "assistant",
            content:
              finalResponse ||
              "I was in the middle of using tools to complete your request.",
          },
          {
            role: "user",
            content:
              "You have reached the maximum number of steps. Please provide a concise final response describing what completed and what remains.",
          },
        ],
        providerOptions: getDefaultProviderOptions(),
        abortSignal: signal,
        onChunk: ({ chunk }) => {
          if (chunk.type !== "text-delta") return;
          if (!fallbackResponse && !chunk.text.trim()) return;
          fallbackResponse += chunk.text;
          callbacks.onResponseDelta(chunk.text, fallbackResponse);
        },
      });
      finalResponse = await fallback.text;
      if (!fallbackResponse && finalResponse) {
        callbacks.onResponseDelta(finalResponse, finalResponse);
      }
      toolSummary.push("Max step guardrail reached");
      callbacks.onAudit?.("max_step_guardrail", { stepCount: steps.length });
    }

    finalResponse = normalizeFinalResponse(
      finalResponse,
      toolSummary,
      callbacks,
    );

    callbacks.onAudit?.("run_completed", {
      response: finalResponse,
      toolSummary,
    });
    callbacks.onCompleted(finalResponse, toolSummary);
  } catch (err) {
    if (signal.aborted) {
      callbacks.onAudit?.("run_cancelled");
      callbacks.onCancelled();
      return;
    }
    logSidecar("Agent runtime error", err);
    const error = formatProviderError(err);
    callbacks.onAudit?.("run_failed", { error });
    callbacks.onFailed(error);
  }
}
