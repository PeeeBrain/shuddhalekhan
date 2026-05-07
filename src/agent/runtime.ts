import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, stepCountIs, type JSONValue, type Tool } from 'ai';
import type { AppConfig } from '../types/ipc';
import { logSidecar } from './protocol';

export interface AgentRuntimeCallbacks {
  onStatus(status: string): void;
  onCompleted(response: string, toolSummary: string[]): void;
  onFailed(error: string): void;
  onCancelled(): void;
  requestToolApproval(request: ToolApprovalRequest): Promise<ToolApprovalDecision>;
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

const SYSTEM_PROMPT = `You are Shuddhalekhan Agent, a stateless voice assistant. You execute one-off commands. You respect tool policies and approval decisions. If a tool call is rejected with "Rejected: tool approval window expired.", the likely cause is that the user is no longer deliberately focused on the request. Stop execution and respond that you have stopped and are waiting for the user's deliberate focus. Be concise.`;

function getApiKey(envVarName: string): string | undefined {
  return process.env[envVarName];
}

function looksLikeRawApiKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_-]/.test(value.trim());
}

function getProviderHeaders(baseUrl: string): Record<string, string> | undefined {
  if (!baseUrl.includes('openrouter.ai')) return undefined;

  return {
    'HTTP-Referer': 'https://github.com/parthashirolkar/shuddhalekhan',
    'X-OpenRouter-Title': 'Shuddhalekhan',
  };
}

function isOpenRouterBaseUrl(baseUrl: string): boolean {
  return baseUrl.includes('openrouter.ai');
}

function applyDefaultReasoningOptions(args: Record<string, unknown>, baseUrl: string): Record<string, unknown> {
  if (!isOpenRouterBaseUrl(baseUrl)) return args;

  return {
    ...args,
    reasoning: {
      ...(typeof args.reasoning === 'object' && args.reasoning !== null ? args.reasoning : {}),
      effort: 'none',
    },
  };
}

type AgentProviderOptions = Record<string, Record<string, JSONValue>>;

function getDefaultProviderOptions(baseUrl: string): AgentProviderOptions {
  const options: AgentProviderOptions = {
    openaiCompatible: {
      reasoningEffort: 'none',
    },
    shuddhalekhan: {
      reasoningEffort: 'none',
    },
  };

  if (isOpenRouterBaseUrl(baseUrl)) {
    options.shuddhalekhan = {
      reasoningEffort: 'none',
      reasoning: {
        effort: 'none',
      },
    };
  }

  return options;
}

function formatProviderError(err: unknown): string {
  const messages = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;

    if (typeof record.message === 'string') {
      messages.add(record.message);
    }

    const statusCode = record.statusCode ?? record.status;
    if (typeof statusCode === 'number') {
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

  return Array.from(messages).join(' | ');
}

function stringifyForMessage(value: unknown): string {
  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function runAgent(
  _agentRunId: string,
  transcript: string,
  config: AppConfig,
  tools: Record<string, Tool>,
  signal: AbortSignal,
  callbacks: AgentRuntimeCallbacks
): Promise<void> {
  try {
    callbacks.onAudit?.('run_started', {
      transcript,
      modelVisibleMessages: [{ role: 'user', content: transcript }],
      toolNames: Object.keys(tools),
    });

    const provider = config.agent.provider;
    if (!provider.baseUrl || !provider.model || !provider.apiKeyEnvVar) {
      callbacks.onFailed('Agent provider configuration is incomplete. Check base URL, model, and API key environment variable in Settings.');
      return;
    }

    const apiKey = getApiKey(provider.apiKeyEnvVar);
    if (!apiKey) {
      if (looksLikeRawApiKey(provider.apiKeyEnvVar)) {
        callbacks.onFailed(
          'Settings contains an API key value, but Shuddhalekhan expects an environment variable name. Set OPENROUTER_API_KEY in your shell, restart bun run dev, and put OPENROUTER_API_KEY in Settings.'
        );
        return;
      }

      callbacks.onFailed(`API key environment variable "${provider.apiKeyEnvVar}" is not set.`);
      return;
    }

    callbacks.onStatus('Connecting to tools...');

    const model = createOpenAICompatible({
      name: 'shuddhalekhan',
      baseURL: provider.baseUrl,
      apiKey,
      headers: getProviderHeaders(provider.baseUrl),
      transformRequestBody: (args) => applyDefaultReasoningOptions(args, provider.baseUrl),
    }).chatModel(provider.model);

    callbacks.onStatus('Thinking...');

    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: transcript }],
      tools,
      providerOptions: getDefaultProviderOptions(provider.baseUrl),
      stopWhen: stepCountIs(5),
      abortSignal: signal,
      onStepFinish: ({ toolCalls }) => {
        if (toolCalls.length > 0) {
          const names = toolCalls.map((t) => String(t.toolName)).join(', ');
          callbacks.onAudit?.('tool_requests', { toolCalls });
          callbacks.onStatus(`Using tools: ${names}`);
        } else {
          callbacks.onStatus('Thinking...');
        }
      },
    });

    let finalResponse = result.text;
    const toolSummary: string[] = [];

    for (const step of result.steps) {
      for (const tc of step.toolCalls) {
        toolSummary.push(`Used ${String(tc.toolName)}`);
      }
      if (step.toolResults.length > 0) {
        callbacks.onAudit?.('tool_results', { toolResults: step.toolResults });
      }
    }

    const reachedMaxSteps = result.steps.length >= 5;
    const hasPendingToolCalls = result.toolCalls.length > result.toolResults.length;

    if (reachedMaxSteps && hasPendingToolCalls) {
      callbacks.onStatus('Step limit reached. Summarizing...');
      const fallback = await generateText({
        model,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: transcript },
          {
            role: 'assistant',
            content: result.text || 'I was in the middle of using tools to complete your request.',
          },
          {
            role: 'user',
            content:
              'You have reached the maximum number of steps. Please provide a concise final response describing what completed and what remains.',
          },
        ],
        providerOptions: getDefaultProviderOptions(provider.baseUrl),
        abortSignal: signal,
      });
      finalResponse = fallback.text;
      toolSummary.push('Max step guardrail reached');
      callbacks.onAudit?.('max_step_guardrail', { stepCount: result.steps.length });
    }

    callbacks.onAudit?.('run_completed', { response: finalResponse, toolSummary });
    callbacks.onCompleted(finalResponse, toolSummary);
  } catch (err) {
    if (signal.aborted) {
      callbacks.onAudit?.('run_cancelled');
      callbacks.onCancelled();
      return;
    }
    logSidecar('Agent runtime error', err);
    const error = formatProviderError(err);
    callbacks.onAudit?.('run_failed', { error });
    callbacks.onFailed(error);
  }
}
