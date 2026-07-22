import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { isStepCount, streamText, type JSONValue, type ModelMessage, type Tool } from "ai";
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
- Stop and hand back to the user when the request requires missing credentials, an unavailable tool, refused consent, or an unsafe/destructive action that was not explicitly requested.
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
- If a Tool Approval Response is denied with the reason "Tool approval window expired.", stop execution and say the request stopped because tool approval expired.
- Do not mention deliberate focus unless that exact timeout denial reason was received.
- If a denied Tool Approval Response contains corrective feedback that changes the target, arguments, or scope, revise the tool call and continue.
- If a denied Tool Approval Response refuses the action or withholds consent, stop and explain the limitation briefly.
- Never retry the exact same rejected tool call with the same arguments.
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

type ApprovalRequestPart = {
  type: "tool-approval-request";
  approvalId: string;
  toolCall: {
    toolCallId?: string;
    toolName: string;
    input?: unknown;
  };
};

type StreamPart =
  | { type: "text-delta"; text?: string; textDelta?: string }
  | { type: "reasoning"; text?: string; textDelta?: string }
  | ApprovalRequestPart
  | { type: string; [key: string]: unknown };

async function consumeGenerationStream(
  result: {
    text: PromiseLike<string>;
    stream?: AsyncIterable<StreamPart>;
  },
  callbacks: AgentRuntimeCallbacks,
): Promise<{ text: string; approvalRequests: ApprovalRequestPart[] }> {
  let streamedResponse = "";
  const approvalRequests: ApprovalRequestPart[] = [];

  if (result.stream) {
    for await (const part of result.stream) {
      if (isApprovalRequestPart(part)) {
        approvalRequests.push(part);
        continue;
      }

      if (part.type !== "text-delta") continue;
      const text = typeof part.text === "string" ? part.text : typeof part.textDelta === "string" ? part.textDelta : "";
      if (!streamedResponse && !text.trim()) continue;
      streamedResponse += text;
      callbacks.onResponseDelta(text, streamedResponse);
    }
  }

  const finalText = await result.text;
  if (!streamedResponse && finalText) {
    callbacks.onResponseDelta(finalText, finalText);
  }

  return { text: finalText || streamedResponse, approvalRequests };
}

function isApprovalRequestPart(part: StreamPart): part is ApprovalRequestPart {
  return (
    part.type === "tool-approval-request" &&
    typeof (part as { approvalId?: unknown }).approvalId === "string" &&
    typeof (part as { toolCall?: { toolName?: unknown } }).toolCall?.toolName === "string"
  );
}

function toApprovalRequest(part: ApprovalRequestPart): ToolApprovalRequest {
  const modelToolName = part.toolCall.toolName;
  const separatorIndex = modelToolName.indexOf("__");
  return {
    serverId: separatorIndex > 0 ? modelToolName.slice(0, separatorIndex) : "",
    toolName: separatorIndex > 0 ? modelToolName.slice(separatorIndex + 2) : modelToolName,
    modelToolName,
    arguments: part.toolCall.input,
  };
}

function toApprovalReason(decision: ToolApprovalDecision): string {
  if (decision.approved) return "User approved tool execution.";
  return decision.message.trim() || "User denied tool execution.";
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
  storedApiKey?: string,
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
    if (provider.apiKeySource === 'stored') {
      if (!storedApiKey) {
        callbacks.onFailed('The saved API key is unavailable. Replace it in Settings or use an environment variable.');
        return;
      }
      apiKey = storedApiKey;
    } else if (requiresApiKey(provider.baseUrl)) {
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
    const messages: ModelMessage[] = [{ role: "user", content: transcript }];
    const toolSummary: string[] = [];
    let finalResponse = "";
    let steps: Array<{ toolCalls: Array<{ toolName: string }>; toolResults: unknown[] }> = [];
    let toolCalls: unknown[] = [];
    let toolResults: unknown[] = [];

    while (true) {
      callbacks.onStatus("Thinking...");
      const result = streamText({
        model,
        instructions: systemPrompt,
        messages,
        tools,
        providerOptions: getDefaultProviderOptions(),
        stopWhen: isStepCount(5),
        abortSignal: signal,
        onStepEnd: ({ toolCalls }) => {
          if (toolCalls.length > 0) {
            const names = toolCalls.map((t) => String(t.toolName)).join(", ");
            callbacks.onAudit?.("tool_requests", { toolCalls });
            callbacks.onStatus(`Using tools: ${names}`);
          } else {
            callbacks.onStatus("Thinking...");
          }
        },
      });

      const consumed = await consumeGenerationStream(result, callbacks);
      finalResponse = consumed.text;
      if (result.responseMessages) {
        messages.push(...((await result.responseMessages) as ModelMessage[]));
      }

      steps = await result.steps;
      toolCalls = await result.toolCalls;
      toolResults = await result.toolResults;

      for (const step of steps) {
        for (const tc of step.toolCalls) {
          toolSummary.push(`Used ${String(tc.toolName)}`);
        }
        if (step.toolResults.length > 0) {
          callbacks.onAudit?.("tool_results", { toolResults: step.toolResults });
        }
      }

      if (consumed.approvalRequests.length === 0) break;

      callbacks.onAudit?.("tool_approval_requests", {
        approvalRequests: consumed.approvalRequests,
      });
      const approvalResponses = [];
      for (const request of consumed.approvalRequests) {
        const decision = await callbacks.requestToolApproval(toApprovalRequest(request));
        approvalResponses.push({
          type: "tool-approval-response" as const,
          approvalId: request.approvalId,
          approved: decision.approved,
          reason: toApprovalReason(decision),
        });
      }
      callbacks.onAudit?.("tool_approval_responses_sent", {
        approvalResponses,
      });
      messages.push({ role: "tool", content: approvalResponses } as ModelMessage);
    }

    const reachedMaxSteps = steps.length >= 5;
    const hasPendingToolCalls = toolCalls.length > toolResults.length;

    if (reachedMaxSteps && hasPendingToolCalls) {
      callbacks.onStatus("Step limit reached. Summarizing...");
      const fallback = streamText({
        model,
        instructions: systemPrompt,
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
      });
      finalResponse = (await consumeGenerationStream(fallback, callbacks)).text;
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
      callbacks.onAudit?.("run_interrupted");
      callbacks.onCancelled();
      return;
    }
    logSidecar("Agent runtime error", err);
    const error = formatProviderError(err);
    callbacks.onAudit?.("run_failed", { error });
    callbacks.onFailed(error);
  }
}
