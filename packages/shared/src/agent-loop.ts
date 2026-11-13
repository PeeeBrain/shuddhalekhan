import { isStepCount, streamText, type LanguageModelUsage, type ModelMessage, type SystemModelMessage, type Tool } from 'ai';
import type { AgentModelClient } from './agent-model';

/** Model calls allowed per command, counted across approval pauses. The last one must answer without tools. */
export const AGENT_MAX_STEPS = 30;
const TOOL_RESULT_CHAR_LIMIT = 100_000;
// ponytail: counts tool-result characters only (roughly 100k tokens); spoken commands and answers are small. Count tokens if a provider overflows first.
const CONTEXT_CHAR_BUDGET = 400_000;
const CLEARED_RESULT = '[Earlier tool result removed to save context. Call the tool again if you still need it.]';
const WRAP_UP: ModelMessage = {
  role: 'user',
  content: 'You have reached the maximum number of steps. Do not call tools. Give a concise final response describing what completed and what remains.',
};

export type ToolApprovalDecision = { approved: true } | { approved: false; message: string };

type ApprovalRequestPart = {
  type: 'tool-approval-request';
  approvalId: string;
  toolCall: { toolCallId: string; toolName: string; input?: unknown };
};
type StreamPart =
  | { type: 'text-delta'; text?: string; textDelta?: string }
  | { type: 'error'; error: unknown }
  | ApprovalRequestPart
  | { type: string; [key: string]: unknown };

function isApprovalRequestPart(part: StreamPart): part is ApprovalRequestPart {
  return part.type === 'tool-approval-request'
    && typeof (part as { approvalId?: unknown }).approvalId === 'string'
    && typeof (part as { toolCall?: { toolName?: unknown } }).toolCall?.toolName === 'string';
}

async function consumeStream(
  result: { text: PromiseLike<string>; stream?: AsyncIterable<StreamPart> },
  onResponseDelta: (delta: string, fullText: string) => void,
): Promise<{ text: string; approvalRequests: ApprovalRequestPart[] }> {
  let streamed = '';
  const approvalRequests: ApprovalRequestPart[] = [];
  let streamError: unknown;
  for await (const part of result.stream ?? []) {
    if (isApprovalRequestPart(part)) { approvalRequests.push(part); continue; }
    if (part.type === 'error') { streamError = part.error; continue; }
    if (part.type !== 'text-delta') continue;
    const text = typeof part.text === 'string' ? part.text : typeof part.textDelta === 'string' ? part.textDelta : '';
    if (!streamed && !text.trim()) continue;
    streamed += text;
    onResponseDelta(text, streamed);
  }
  if (streamError !== undefined) throw streamError;
  const finalText = await result.text;
  if (!streamed && finalText) onResponseDelta(finalText, finalText);
  return { text: finalText || streamed, approvalRequests };
}

/**
 * Keeps a long run inside the model's context: one oversized tool result is truncated, and once the
 * results together pass the budget the oldest are replaced by a placeholder. Message structure is
 * never changed, so reasoning and tool-call pairs stay valid for every provider. Cleared ids are
 * remembered, so the prompt prefix stays stable (and cacheable) until the budget is passed again.
 */
function createCompactor() {
  const cleared = new Set<string>();
  const compact = (messages: ModelMessage[]): ModelMessage[] => {
    const kept: Array<{ id: string; size: number }> = [];
    const next = messages.map(message => message.role !== 'tool' ? message : { ...message, content: message.content.map(part => {
      if (part.type !== 'tool-result') return part;
      if (cleared.has(part.toolCallId)) return { ...part, output: { type: 'text' as const, value: CLEARED_RESULT } };
      const text = part.output.type === 'text' ? part.output.value : JSON.stringify(part.output);
      kept.push({ id: part.toolCallId, size: Math.min(text.length, TOOL_RESULT_CHAR_LIMIT) });
      return text.length <= TOOL_RESULT_CHAR_LIMIT ? part : { ...part, output: { type: 'text' as const,
        value: `${text.slice(0, TOOL_RESULT_CHAR_LIMIT)}\n[Tool result truncated: it was ${text.length} characters long.]` } };
    }) });
    let total = kept.reduce((sum, result) => sum + result.size, 0);
    if (total <= CONTEXT_CHAR_BUDGET) return next;
    // Always keep the newest result: the model has not read it yet.
    for (const result of kept.slice(0, -1)) {
      if (total <= CONTEXT_CHAR_BUDGET / 2) break;
      cleared.add(result.id);
      total -= result.size;
    }
    return compact(messages);
  };
  return compact;
}

export type AgentLoopResult = {
  text: string;
  /** The whole conversation, compacted. Pass it back as `messages` (plus a new user message) to continue. */
  messages: ModelMessage[];
  toolNames: string[];
  stepLimitReached: boolean;
  /** The last step stopped at the model's output limit, so `text` may be cut off. */
  outputLimitReached: boolean;
};

/**
 * The agent run shared by desktop and iOS: stream model steps, pause for tool approvals, resume,
 * and stop within the step budget. Callers own tools, policy, UI and persistence.
 */
export async function runAgentLoop({ client, instructions, messages: initialMessages, tools, signal, maxSteps = AGENT_MAX_STEPS,
  onStatus, onResponseDelta, requestToolApproval, onStepEnd, onAudit }: {
  client: AgentModelClient;
  instructions: string;
  messages: ModelMessage[];
  tools: Record<string, Tool>;
  signal: AbortSignal;
  maxSteps?: number;
  onStatus(status: string): void;
  onResponseDelta(delta: string, fullText: string): void;
  requestToolApproval(request: { modelToolName: string; arguments: unknown }): Promise<ToolApprovalDecision>;
  onStepEnd?(step: { toolCalls: Array<{ toolName: string }>; warnings?: unknown[]; usage: LanguageModelUsage }): void;
  onAudit?(eventType: string, payload?: Record<string, unknown>): void;
}): Promise<AgentLoopResult> {
  const system: SystemModelMessage = { role: 'system', content: instructions, providerOptions: client.cacheMessageOptions };
  const messages = [...initialMessages];
  const stableTools = Object.fromEntries(Object.entries(tools).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  const compact = createCompactor();
  const toolNames: string[] = [];
  let text = '';
  let usedSteps = 0;
  let outputLimitReached = false;

  while (true) {
    onStatus('Thinking...');
    const stepsBefore = usedSteps;
    const result = streamText({
      model: client.model,
      onError: () => undefined,
      instructions: system,
      messages,
      tools: stableTools,
      providerOptions: client.providerOptions,
      prepareStep: ({ messages: stepMessages, stepNumber }) => {
        const lastStep = stepsBefore + stepNumber + 1 >= maxSteps;
        const prepared = compact(lastStep ? [...stepMessages, WRAP_UP] : stepMessages);
        return {
          messages: client.prepareStep?.({ messages: prepared }).messages ?? prepared,
          // `none` keeps the tool definitions in the request, so the cached prefix survives the final step.
          ...(lastStep ? { toolChoice: 'none' as const } : {}),
        };
      },
      // A hung tool fails as a tool error the model can read; it does not end the run.
      timeout: { firstChunkMs: 180_000, chunkMs: 60_000, toolMs: 120_000 },
      stopWhen: isStepCount(maxSteps - usedSteps),
      abortSignal: signal,
      onStepEnd: step => {
        onStepEnd?.(step);
        if (step.toolCalls.length > 0) {
          onAudit?.('tool_requests', { toolCalls: step.toolCalls });
          onStatus(`Using tools: ${step.toolCalls.map(call => String(call.toolName)).join(', ')}`);
        } else {
          onStatus('Thinking...');
        }
      },
    });

    const consumed = await consumeStream(result, onResponseDelta);
    text = consumed.text;
    const steps = await result.steps;
    usedSteps += steps.length;
    outputLimitReached = steps.at(-1)?.finishReason === 'length';
    for (const step of steps) {
      toolNames.push(...step.toolCalls.map(call => String(call.toolName)));
      if (step.toolResults.length > 0) onAudit?.('tool_results', { toolResults: step.toolResults });
    }
    messages.push(...await result.responseMessages);
    if (consumed.approvalRequests.length === 0) break;
    // A model that ignores `toolChoice: none` on its final step still asks for tools. Deny them, so a
    // reply sees a result for every call (and keeps results of tools approved earlier in this round).
    if (usedSteps >= maxSteps) {
      messages.push({ role: 'tool', content: consumed.approvalRequests.map(request => ({
        type: 'tool-result' as const, toolCallId: request.toolCall.toolCallId, toolName: request.toolCall.toolName,
        output: { type: 'execution-denied' as const, reason: 'Step limit reached.' },
      })) });
      break;
    }

    onAudit?.('tool_approval_requests', { approvalRequests: consumed.approvalRequests });
    const approvalResponses = [];
    // One at a time: each request is its own decision on screen.
    for (const request of consumed.approvalRequests) {
      const decision = await requestToolApproval({ modelToolName: request.toolCall.toolName, arguments: request.toolCall.input });
      approvalResponses.push({
        type: 'tool-approval-response' as const, approvalId: request.approvalId, approved: decision.approved,
        reason: decision.approved ? 'User approved tool execution.' : decision.message.trim() || 'User denied tool execution.',
      });
    }
    onAudit?.('tool_approval_responses_sent', { approvalResponses });
    messages.push({ role: 'tool', content: approvalResponses });
  }

  return { text, messages: compact(messages), toolNames, stepLimitReached: usedSteps >= maxSteps, outputLimitReached };
}
