import { isStepCount, streamText, type ModelMessage, type SystemModelMessage, type Tool } from "ai";
import type { AppConfig } from "../types/ipc";
import { logSidecar } from "./protocol";
import { createAgentProvider } from "./provider";
import { providerDiagnostic, redactProviderText } from "./provider-diagnostic";
import type { AgentMemoryCommitResult, AgentMemoryUpdate, AgentRunContext } from '../shared/agent-context';
import { createSkillTools } from './skills';
import { learnAgentMemory } from './memory';

export interface AgentRuntimeCallbacks {
  onStatus(status: string): void;
  onProviderRequestStarted?(): void;
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
  commitMemory?(revision: string, updates: AgentMemoryUpdate[]): Promise<AgentMemoryCommitResult>;
  onMemoryStatus?(status: string): void;
  shouldLearnMemory?(): boolean;
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

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const LOCAL_DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "long",
});

function buildRuntimeContext(now = new Date()): string {
  const localDateTime = LOCAL_DATE_TIME_FORMATTER.format(now);

  return `<runtime_context>
- Current local datetime: ${localDateTime}
- Current UTC datetime: ${now.toISOString()}
- Time zone: ${TIME_ZONE}
- Use this datetime context when interpreting relative dates like today, tomorrow, yesterday, tonight, this week, current year, or latest.
</runtime_context>`;
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
  | { type: "error"; error: unknown }
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
  let streamError: unknown;

  if (result.stream) {
    for await (const part of result.stream) {
      if (isApprovalRequestPart(part)) {
        approvalRequests.push(part);
        continue;
      }

      if (part.type === "error") {
        streamError = part.error;
        continue;
      }

      if (part.type !== "text-delta") continue;
      const text = typeof part.text === "string" ? part.text : typeof part.textDelta === "string" ? part.textDelta : "";
      if (!streamedResponse && !text.trim()) continue;
      streamedResponse += text;
      callbacks.onResponseDelta(text, streamedResponse);
    }
  }

  if (streamError !== undefined) {
    throw streamError;
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

type ToolApprovalResponsePart = {
  type: "tool-approval-response";
  approvalId: string;
  approved: boolean;
  reason: string;
};

async function collectApprovalResponsesSequentially(
  requests: ApprovalRequestPart[],
  requestToolApproval: AgentRuntimeCallbacks["requestToolApproval"],
  index = 0,
  responses: ToolApprovalResponsePart[] = [],
): Promise<ToolApprovalResponsePart[]> {
  const request = requests[index];
  if (!request) return responses;

  const decision = await requestToolApproval(toApprovalRequest(request));
  responses.push({
    type: "tool-approval-response",
    approvalId: request.approvalId,
    approved: decision.approved,
    reason: toApprovalReason(decision),
  });
  return collectApprovalResponsesSequentially(requests, requestToolApproval, index + 1, responses);
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
  agentRunId: string,
  transcript: string,
  config: Pick<AppConfig, 'agent'>,
  tools: Record<string, Tool>,
  signal: AbortSignal,
  callbacks: AgentRuntimeCallbacks,
  storedApiKey?: string,
  context?: AgentRunContext,
): Promise<void> {
  let apiKey = storedApiKey;
  try {
    let skillContext = '';
    let skillNotice = '';
    let runTools = tools;
    if (context) {
      try {
        const skills = createSkillTools(context.skillsDirectory, config.agent.disabledSkills ?? [], signal, callbacks.onAudit);
        if (Object.keys(skills.tools).some(name => name in tools)) throw new Error('An MCP tool conflicts with an internal skill tool.');
        skillContext = skills.context;
        runTools = { ...tools, ...skills.tools };
      } catch (error) {
        callbacks.onAudit?.('skills_unavailable', { error: error instanceof Error ? error.message : 'Skills could not be loaded.' });
        skillNotice = 'Some skills are unavailable. Check Skills in Settings.';
        callbacks.onStatus(skillNotice);
      }
    }
    const memory = config.agent.memoryEnabled ? context?.memory : null;
    const rememberedContext = memory?.markdown ? `Remembered user facts (may be outdated; the current command takes precedence):\n${memory.markdown}` : '';
    const extraContext = [skillContext, rememberedContext].filter(Boolean).join('\n\n');
    const command: ModelMessage = { role: "user", content: `${buildRuntimeContext()}${extraContext ? `\n\n<agent_context>\n${extraContext}\n</agent_context>` : ''}\n\n${transcript}` };
    callbacks.onAudit?.("run_started", {
      transcript,
      modelVisibleMessages: [command],
      toolNames: Object.keys(runTools),
    });

    const client = createAgentProvider(config.agent.provider, storedApiKey, agentRunId);
    const { model, providerOptions, prepareStep } = client;
    apiKey = client.apiKey;

    callbacks.onStatus("Thinking...");

    const instructions: SystemModelMessage = { role: 'system', content: SYSTEM_PROMPT, providerOptions: client.cacheMessageOptions };
    const messages: ModelMessage[] = [command];
    const stableTools = Object.fromEntries(Object.entries(runTools).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    const auditUsage = ({ usage }: { usage: import('ai').LanguageModelUsage }) => {
      const deepSeekCacheRead = usage.raw?.prompt_cache_hit_tokens;
      const rawDetails = usage.raw?.prompt_tokens_details ?? usage.raw?.input_tokens_details;
      const cacheRead = rawDetails && typeof rawDetails === 'object' && 'cached_tokens' in rawDetails ? rawDetails.cached_tokens : undefined;
      const cacheWrite = rawDetails && typeof rawDetails === 'object' && 'cache_write_tokens' in rawDetails ? rawDetails.cache_write_tokens : undefined;
      callbacks.onAudit?.('provider_usage', {
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        cacheReadTokens: typeof deepSeekCacheRead === 'number' ? deepSeekCacheRead
          : typeof cacheRead === 'number' ? cacheRead : usage.inputTokenDetails.cacheReadTokens || undefined,
        cacheWriteTokens: typeof cacheWrite === 'number' ? cacheWrite
          : usage.inputTokenDetails.cacheWriteTokens || undefined,
      });
    };
    const toolSummary: string[] = skillNotice ? [skillNotice] : [];
    let finalResponse = "";
    let steps: Array<{ toolCalls: Array<{ toolName: string }>; toolResults: unknown[] }> = [];
    let toolCalls: unknown[] = [];
    let toolResults: unknown[] = [];

    while (true) {
      callbacks.onStatus("Thinking...");
      callbacks.onProviderRequestStarted?.();
      const result = streamText({
        model,
        onError: () => undefined,
        instructions,
        messages,
        tools: stableTools,
        providerOptions,
        prepareStep,
        timeout: { firstChunkMs: 180_000, chunkMs: 60_000 },
        stopWhen: isStepCount(5),
        abortSignal: signal,
        onStepEnd: ({ toolCalls, warnings, usage }) => {
          auditUsage({ usage });
          if (warnings?.length) {
            callbacks.onAudit?.("provider_warnings", { warnings: warnings.slice(0, 10).map(warning => redactProviderText(JSON.stringify(warning), apiKey).slice(0, 800)) });
            const warning = "Provider reported unsupported settings. Run Test model in Settings.";
            if (!toolSummary.includes(warning)) toolSummary.push(warning);
          }
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
      const approvalResponses = await collectApprovalResponsesSequentially(
        consumed.approvalRequests,
        callbacks.requestToolApproval,
      );
      callbacks.onAudit?.("tool_approval_responses_sent", {
        approvalResponses,
      });
      messages.push({ role: "tool", content: approvalResponses } as ModelMessage);
    }

    const reachedMaxSteps = steps.length >= 5;
    const hasPendingToolCalls = toolCalls.length > toolResults.length;

    if (reachedMaxSteps && hasPendingToolCalls) {
      callbacks.onStatus("Step limit reached. Summarizing...");
      callbacks.onProviderRequestStarted?.();
      const fallback = streamText({
        model,
        onError: () => undefined,
        instructions,
        messages: [
          command,
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
        providerOptions,
        prepareStep,
        onStepEnd: auditUsage,
        timeout: { firstChunkMs: 180_000, chunkMs: 60_000 },
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

    if (memory && callbacks.shouldLearnMemory?.() !== false) {
      const memoryNotice = await learnAgentMemory({ agentRunId, transcript, config, memory, storedApiKey, signal, callbacks });
      if (memoryNotice) toolSummary.push(memoryNotice);
    }
    signal.throwIfAborted();
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
    const diagnostic = providerDiagnostic(err, apiKey);
    const error = `${diagnostic.message} ${diagnostic.action}${diagnostic.statusCode ? ` (HTTP ${diagnostic.statusCode})` : ""}`;
    logSidecar("Agent runtime error", error);
    callbacks.onAudit?.("run_failed", { error, diagnostic });
    callbacks.onFailed(error);
  }
}
