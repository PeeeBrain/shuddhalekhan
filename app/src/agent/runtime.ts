import { buildSystemPrompt, buildRuntimeContext } from '@shuddhalekhan/shared/agent-prompt';
import { AGENT_MAX_STEPS, runAgentLoop, type AgentStep, type ToolApprovalDecision } from '@shuddhalekhan/shared/agent-loop';
import { parseModelToolName } from '@shuddhalekhan/shared/mcp';
import type { ModelMessage, Tool } from "ai";
import type { AppConfig } from "../types/ipc";
import { logSidecar } from "./protocol";
import { createAgentProvider } from "./provider";
import { providerDiagnostic, redactProviderText } from "./provider-diagnostic";
import type { AgentMemoryCommitResult, AgentMemoryUpdate, AgentRunContext } from '../shared/agent-context';
import { createSkillTools } from './skills';
import { learnAgentMemory } from './memory';

export type { ToolApprovalDecision };

export interface AgentRuntimeCallbacks {
  onStatus(status: string): void;
  /** The run's steps so far, the last one live; read before returning. */
  onSteps(steps: AgentStep[]): void;
  /** `steps` are the ones before the answer; `toolSummary` holds notices about the run. */
  onCompleted(response: string, toolSummary: string[], steps: AgentStep[]): void;
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

function normalizeFinalResponse(
  response: string,
  toolNames: string[],
  callbacks: AgentRuntimeCallbacks,
): string {
  if (response.trim()) return response;

  const hadToolActivity = toolNames.length > 0;
  callbacks.onAudit?.("empty_response_degraded", {
    toolNames,
    hadToolActivity,
  });

  return hadToolActivity
    ? "The agent completed tool work but returned no final text."
    : "The agent completed, but returned an empty response.";
}

/**
 * Runs one spoken command. `history` is the conversation of the run being continued, if any.
 * Resolves with the conversation to continue from, or null when the run did not complete.
 */
export async function runAgent(
  agentRunId: string,
  transcript: string,
  config: Pick<AppConfig, 'agent'>,
  tools: Record<string, Tool>,
  signal: AbortSignal,
  callbacks: AgentRuntimeCallbacks,
  storedApiKey?: string,
  context?: AgentRunContext,
  history: ModelMessage[] = [],
): Promise<ModelMessage[] | null> {
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
      continuedMessageCount: history.length,
      toolNames: Object.keys(runTools),
    });

    const client = createAgentProvider(config.agent.provider, storedApiKey, agentRunId);
    apiKey = client.apiKey;

    const toolSummary: string[] = skillNotice ? [skillNotice] : [];
    const loop = await runAgentLoop({
      client,
      instructions: buildSystemPrompt(config.agent.customInstructions),
      messages: [...history, command],
      tools: runTools,
      signal,
      onStatus: callbacks.onStatus,
      onSteps: callbacks.onSteps,
      onAudit: callbacks.onAudit,
      requestToolApproval: request => callbacks.requestToolApproval({ ...parseModelToolName(request.modelToolName), ...request }),
      onStepEnd: ({ warnings, usage }) => {
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
        if (warnings?.length) {
          callbacks.onAudit?.("provider_warnings", { warnings: warnings.slice(0, 10).map(warning => redactProviderText(JSON.stringify(warning), apiKey).slice(0, 800)) });
          const warning = "Provider reported unsupported settings. Run Test model in Settings.";
          if (!toolSummary.includes(warning)) toolSummary.push(warning);
        }
      },
    });
    if (loop.stepLimitReached) {
      toolSummary.push("Max step guardrail reached");
      callbacks.onAudit?.("max_step_guardrail", { stepCount: AGENT_MAX_STEPS });
    }
    const finalResponse = normalizeFinalResponse(
      // In the answer itself: the card shows only the first few summary entries.
      loop.outputLimitReached ? `${loop.text}\n\n_Cut off at the model's output limit._` : loop.text,
      loop.toolNames,
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
    callbacks.onCompleted(finalResponse, toolSummary, loop.steps);
    return loop.messages;
  } catch (err) {
    if (signal.aborted) {
      callbacks.onAudit?.("run_interrupted");
      callbacks.onCancelled();
      return null;
    }
    const diagnostic = providerDiagnostic(err, apiKey);
    const error = `${diagnostic.message} ${diagnostic.action}${diagnostic.statusCode ? ` (HTTP ${diagnostic.statusCode})` : ""}`;
    logSidecar("Agent runtime error", error);
    callbacks.onAudit?.("run_failed", { error, diagnostic });
    callbacks.onFailed(error);
    return null;
  }
}
