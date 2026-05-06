import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, stepCountIs, type Tool } from 'ai';
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { MCPClient } from '@ai-sdk/mcp';
import type { AppConfig, McpServerConfig } from '../types/ipc';
import { logSidecar } from './protocol';

export interface AgentRuntimeCallbacks {
  onStatus(status: string): void;
  onCompleted(response: string, toolSummary: string[]): void;
  onFailed(error: string): void;
  onCancelled(): void;
}

const SYSTEM_PROMPT = `You are Shuddhalekhan Agent, a stateless voice assistant. You execute one-off commands. You respect tool policies and approval decisions. If a tool call is rejected with "Rejected: tool approval window expired.", stop execution and respond that you have stopped and are waiting for the user's deliberate focus. Be concise.`;

function getApiKey(envVarName: string): string | undefined {
  return process.env[envVarName];
}

function createStdioTransport(server: McpServerConfig) {
  if (server.transport.type !== 'stdio') return null;
  const env: Record<string, string> = {};
  for (const name of server.transport.envVarNames) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return new Experimental_StdioMCPTransport({
    command: server.transport.command,
    args: server.transport.args,
    env,
  });
}

function createHttpTransport(server: McpServerConfig) {
  if (server.transport.type !== 'http') return null;
  return {
    type: 'http' as const,
    url: server.transport.url,
  };
}

async function connectMcpClients(config: AppConfig): Promise<{ clients: MCPClient[]; tools: Record<string, Tool> }> {
  const clients: MCPClient[] = [];
  const allTools: Record<string, Tool> = {};

  for (const server of config.agent.mcpServers) {
    if (!server.enabled) continue;

    try {
      let client: MCPClient;
      if (server.transport.type === 'stdio') {
        const transport = createStdioTransport(server);
        if (!transport) continue;
        client = await createMCPClient({ transport });
      } else if (server.transport.type === 'http') {
        const transport = createHttpTransport(server);
        if (!transport) continue;
        client = await createMCPClient({ transport });
      } else {
        continue;
      }

      const rawTools = await client.tools();
      clients.push(client);

      for (const [originalName, toolDef] of Object.entries(rawTools)) {
        const policyKey = `${server.id}:${originalName}` as const;
        const policy = server.toolPolicies[policyKey] ?? 'alwaysAsk';
        if (policy === 'disabled') continue;
        const modelName = `${server.id}__${originalName}`;
        allTools[modelName] = toolDef;
      }

      logSidecar(`MCP server connected: ${server.id} (${server.displayName})`);
    } catch (err) {
      logSidecar(`MCP server failed: ${server.id}`, err);
    }
  }

  return { clients, tools: allTools };
}

export async function runAgent(
  _agentRunId: string,
  transcript: string,
  config: AppConfig,
  signal: AbortSignal,
  callbacks: AgentRuntimeCallbacks
): Promise<void> {
  let clients: MCPClient[] = [];

  try {
    const provider = config.agent.provider;
    if (!provider.baseUrl || !provider.model || !provider.apiKeyEnvVar) {
      callbacks.onFailed('Agent provider configuration is incomplete. Check base URL, model, and API key environment variable in Settings.');
      return;
    }

    const apiKey = getApiKey(provider.apiKeyEnvVar);
    if (!apiKey) {
      callbacks.onFailed(`API key environment variable "${provider.apiKeyEnvVar}" is not set.`);
      return;
    }

    callbacks.onStatus('Connecting to tools...');
    const mcp = await connectMcpClients(config);
    clients = mcp.clients;

    const model = createOpenAICompatible({
      name: 'shuddhalekhan',
      baseURL: provider.baseUrl,
      apiKey,
    }).chatModel(provider.model);

    callbacks.onStatus('Thinking...');

    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: transcript }],
      tools: mcp.tools,
      stopWhen: stepCountIs(5),
      abortSignal: signal,
      onStepFinish: ({ toolCalls }) => {
        if (toolCalls.length > 0) {
          const names = toolCalls.map((t) => String(t.toolName)).join(', ');
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
        abortSignal: signal,
      });
      finalResponse = fallback.text;
      toolSummary.push('Max step guardrail reached');
    }

    callbacks.onCompleted(finalResponse, toolSummary);
  } catch (err) {
    if (signal.aborted) {
      callbacks.onCancelled();
      return;
    }
    logSidecar('Agent runtime error', err);
    callbacks.onFailed(err instanceof Error ? err.message : String(err));
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  }
}
