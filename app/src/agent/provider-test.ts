import { isStepCount, streamText, tool } from 'ai';
import { z } from 'zod';
import type { AgentProviderConfig, AgentProviderTestResult } from '../types/ipc';
import { failedProviderTest, normalizeAgentProvider } from '../shared/agent-provider';
import { resolveAgentProviderKey } from '../shared/agent-provider-validation';
import { createAgentProvider } from './provider';
import { providerDiagnostic, redactProviderText } from './provider-diagnostic';

export const PROVIDER_TEST_DEADLINE_MS = 75_000;

export async function testAgentProvider(
  provider: AgentProviderConfig,
  signal: AbortSignal,
  storedApiKey?: string,
): Promise<AgentProviderTestResult> {
  const { validation, apiKey } = resolveAgentProviderKey(provider, storedApiKey, process.env);
  const result = failedProviderTest({ kind: 'configuration', message: 'Correct the provider settings before testing.', action: validation.issues[0]?.message ?? 'Check credentials.' }, validation);
  if (validation.issues.length) return result;
  delete result.diagnostic;
  const deadline = AbortSignal.timeout(PROVIDER_TEST_DEADLINE_MS);
  const abortSignal = AbortSignal.any([signal, deadline]);
  let stage: 'streaming' | 'tools' = 'streaming';
  try {
    const client = createAgentProvider(provider, storedApiKey, 'provider-check');
    const profile = normalizeAgentProvider(provider);
    const nativeChat = profile.apiMode === 'chat-completions' && (profile.kind === 'openai' || profile.kind === 'azure-openai');
    const settings = {
      model: client.model,
      instructions: { role: 'system' as const, content: 'You are checking provider compatibility.', providerOptions: client.cacheMessageOptions },
      prepareStep: client.prepareStep,
      // Deployment aliases hide reasoning capabilities from the SDK. The native
      // Chat API budget works without guessing the underlying model family.
      providerOptions: nativeChat ? {
        ...client.providerOptions, openai: { ...client.providerOptions.openai, maxCompletionTokens: 4096 },
      } : client.providerOptions,
      abortSignal,
      onError: () => undefined,
      maxRetries: 0, maxOutputTokens: nativeChat ? undefined : 4096, timeout: { chunkMs: 20_000 },
    };
    const consume = async (generation: {
      stream: AsyncIterable<{ type: string; text?: string; error?: unknown }>;
      text: PromiseLike<string>;
      steps: PromiseLike<Array<{ warnings?: unknown[]; finishReason: string; text: string; toolCalls: unknown[] }>>;
    }) => {
      let streamedText = '';
      for await (const part of generation.stream) {
        if (part.type === 'error') throw part.error;
        if (part.type === 'text-delta' && typeof part.text === 'string') streamedText += part.text;
      }
      const text = await generation.text;
      const steps = await generation.steps;
      for (const step of steps) {
        for (const warning of step.warnings ?? []) {
          const message = redactProviderText(JSON.stringify(warning), apiKey).slice(0, 800);
          if (result.warnings.length < 10 && !result.warnings.includes(message)) result.warnings.push(message);
        }
      }
      const finalStep = steps.at(-1);
      return {
        text, streamedText, limited: steps.some(step => step.finishReason === 'length'),
        answeredAfterTool: steps.length >= 2 && Boolean(finalStep?.text.trim()) && finalStep?.toolCalls.length === 0,
      };
    };
    const first = await consume(streamText({ ...settings, prompt: 'This is a connection check. Reply with only OK.' }));
    result.streaming = first.limited
      ? { status: 'inconclusive', message: 'The output budget was reached. Try a lower supported reasoning effort.' }
      : first.text.trim() && first.streamedText.trim()
        ? { status: 'passed', message: 'The configured model returned streamed text.' }
        : { status: 'failed', message: 'The provider returned no streamed answer.' };
    if (result.streaming.status !== 'passed') return result;
    if (result.warnings.length) result.streaming = { status: 'inconclusive', message: 'Text streamed, but the SDK reported ignored or unsupported settings. Review the warnings.' };

    stage = 'tools';
    let executed = false;
    const echo = tool({
      description: 'Echo the fixed connection-check value. This tool has no external effects.',
      inputSchema: z.object({ value: z.literal('shuddhalekhan-provider-check') }),
      execute: async ({ value }) => { executed = true; return { value }; },
    });
    const second = await consume(streamText({
      ...settings, tools: { provider_check_echo: echo }, stopWhen: isStepCount(2),
      prompt: 'This is a tool compatibility check. Call provider_check_echo with value "shuddhalekhan-provider-check". After receiving its result, reply with only OK.',
    }));
    result.tools = second.limited
      ? { status: 'inconclusive', message: 'The tool check reached its output budget. Try a lower supported reasoning effort.' }
      : !executed
        ? { status: 'inconclusive', message: 'The model did not call the test tool. Tool compatibility was not confirmed.' }
        : second.answeredAfterTool
          ? { status: 'passed', message: 'A harmless tool call executed and the model answered after receiving its result.' }
          : { status: 'failed', message: 'The tool executed, but the model returned no final answer.' };
    if (result.warnings.length && result.tools.status === 'passed') {
      result.tools = { status: 'inconclusive', message: 'The tool round trip completed with SDK warnings. Review ignored settings before using Agent Mode.' };
    }
  } catch (error) {
    result[stage] = { status: 'failed', message: 'This check did not complete.' };
    const interruption = abortSignal.aborted && (error === abortSignal.reason
      || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')));
    result.diagnostic = interruption && signal.aborted && abortSignal.reason === signal.reason
      ? { kind: 'cancelled', message: 'The model test was cancelled.', action: 'Run Test model when ready.' }
      : interruption && deadline.aborted && abortSignal.reason === deadline.reason
        ? { kind: 'timeout', message: 'The model test timed out.', action: 'Check server availability or local model loading, then retry.' }
        : providerDiagnostic(error, apiKey);
  } finally {
    result.checkedAt = new Date().toISOString();
  }
  return result;
}
