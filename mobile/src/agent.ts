import { runAgentLoop } from '@shuddhalekhan/shared/agent-loop';
import { createAgentModel, type AgentFetch } from '@shuddhalekhan/shared/agent-model';
import { buildSystemPrompt, buildRuntimeContext } from '@shuddhalekhan/shared/agent-prompt';
import { APICallError, RetryError, dynamicTool, jsonSchema, type ModelMessage, type Tool } from 'ai';
import { z } from 'zod';
import { MCPConnection, jsonObjectSchema } from './mcp';
import { parseResponse, requestFailed, UNREACHABLE, type Fetch } from './network';
import { toolApprovalPolicy, type MobileSettings } from './settings';
import { chatGptEndpoint, chatGptError } from './chatgpt';
import { agentCredentialsReady } from './providers';
import { validateEndpoint } from './validation';

export type ToolApproval = { serverName: string; toolName: string; arguments: string };

/** A message written for the user. Every other error is replaced before display: it may quote a provider body. */
class AgentError extends Error {}

/**
 * Runs one command on the runtime shared with desktop. iOS adds only its own edges: the saved
 * endpoint and credentials policy, the MCP client, and the approval sheet.
 * `history` is the conversation being replied to; the result's `messages` continue it.
 */
export async function runAgent({ transcript, settings, signal, fetch, onStatus, approve, getChatGptAccessToken, history = [] }: {
  transcript: string; settings: MobileSettings; signal: AbortSignal; fetch: Fetch;
  onStatus: (status: string, completedSteps: number) => void;
  approve: (request: ToolApproval) => Promise<boolean>;
  getChatGptAccessToken?: () => Promise<string>;
  history?: ModelMessage[];
}): Promise<{ text: string; messages: ModelMessage[] }> {
  if (!settings.agentEnabled) throw new Error('Enable Agent Mode in Settings first.');
  if (!transcript.trim()) throw new Error('Record a command first.');
  // Custom servers may run without a key even when a header mode is saved; hosted providers never do.
  const chatgpt = settings.agentProvider === 'chatgpt';
  if (!chatgpt && !agentCredentialsReady(settings)) throw new Error('Enter the agent provider API key in Settings.');
  if (chatgpt && !getChatGptAccessToken) throw new Error('Sign in with ChatGPT in Settings.');
  let completedSteps = 0;
  const status = (message: string) => onStatus(message, completedSteps);

  // Settings store the full request URL. Every model request goes to exactly that URL, whatever path the SDK builds.
  const endpoint = chatgpt ? chatGptEndpoint : settings.agentEndpoint;
  const modelFetch: AgentFetch = async (_input, init) => {
    try { validateEndpoint(endpoint, settings.allowInsecureHTTP); }
    catch (error) { throw new AgentError(error instanceof Error ? error.message : 'Check the agent endpoint URL.'); }
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    // Read the token per request: a long run can outlive one access token.
    if (chatgpt && getChatGptAccessToken) headers.authorization = `Bearer ${await getChatGptAccessToken()}`;
    try { return await fetch(endpoint, { ...init, headers, credentials: 'omit' }); }
    catch (error) {
      // An aborted request is the run's cancellation or the loop's timeout; anything else never reached the server.
      // Native fetch errors may contain credential-bearing URLs, so they are not passed on.
      if (init?.signal?.aborted) throw error;
      throw new AgentError(`Agent model endpoint: ${UNREACHABLE}`);
    }
  };
  const client = createAgentModel({
    kind: settings.agentProvider, baseUrl: endpoint, model: settings.agentModel, apiMode: chatgpt ? 'responses' : settings.agentApiMode,
    auth: chatgpt ? 'none' : settings.agentAuth, reasoning: settings.agentReasoning, cacheBreakpoints: settings.agentCache,
  }, { apiKey: settings.agentKey || undefined, fetch: modelFetch });

  const connections: MCPConnection[] = [];
  const approvals = new Map<string, { serverName: string; toolName: string }>();
  const tools: Record<string, Tool> = {};
  try {
    for (const server of settings.mcpServers.filter(server => server.enabled)) {
      signal.throwIfAborted();
      status(`Connecting to ${server.name}…`);
      const connection = new MCPConnection(server, fetch, settings.allowInsecureHTTP);
      connections.push(connection);
      let discovered;
      try { discovered = await connection.connect(signal); }
      catch (error) {
        if (signal.aborted || !(error instanceof Error)) throw error;
        // The MCP client's errors are already written for display.
        throw new AgentError(`MCP server "${server.name}": ${error.message}`);
      }
      completedSteps++;
      for (const [index, tool] of discovered.entries()) {
        const policy = toolApprovalPolicy(server, tool.name);
        if (policy === 'disabled') continue;
        const name = `mcp_${connections.length}_${index}`;
        approvals.set(name, { serverName: server.name, toolName: tool.name });
        tools[name] = dynamicTool({
          description: `${server.name}: ${tool.name}. ${tool.description ?? ''}`,
          inputSchema: jsonSchema(tool.inputSchema),
          needsApproval: policy !== 'alwaysAllow',
          // A failed call is returned to the model as a tool error, so it can explain or try another way.
          execute: async input => {
            status(`Running ${server.name} / ${tool.name}…`);
            return connection.call(tool.name, parseResponse(jsonObjectSchema, input), signal);
          },
        });
      }
      if (approvals.size > 256) throw new AgentError('Too many enabled MCP tools (maximum 256).');
    }

    status('Waiting for the agent…');
    const result = await runAgentLoop({
      client, signal, tools,
      instructions: buildSystemPrompt(settings.customInstructions),
      messages: [...history, { role: 'user', content: `${buildRuntimeContext()}\n\n${transcript}` }],
      // The loop's own status names tools by their model-facing ids; iOS reports its own stages instead.
      onStatus: () => {},
      onResponseDelta: () => {},
      onStepEnd: () => { completedSteps++; status('Waiting for the agent…'); },
      requestToolApproval: async request => {
        const tool = approvals.get(request.modelToolName);
        if (!tool) return { approved: false, message: 'This tool is unavailable.' };
        status('Waiting for your tool approval…');
        const approved = await approve({ ...tool, arguments: JSON.stringify(request.arguments, null, 2) });
        signal.throwIfAborted();
        return approved ? { approved } : { approved, message: 'User denied tool execution.' };
      },
    });
    const text = result.outputLimitReached ? `${result.text.trim()}\n\n_Cut off at the model's output limit._` : result.text.trim();
    if (!text) throw new AgentError('The agent returned an empty response.');
    status('Agent finished.');
    return { text, messages: result.messages };
  } catch (error) {
    signal.throwIfAborted();
    throw displayError(error, chatgpt);
  } finally {
    await Promise.allSettled(connections.map(connection => connection.close()));
  }
}

function displayError(error: unknown, chatgpt: boolean): Error {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (cause instanceof AgentError) return cause;
  if (APICallError.isInstance(cause) && cause.statusCode) {
    if (!chatgpt) return new Error(`Agent model endpoint: ${requestFailed(cause.statusCode)}`);
    let body: unknown = null;
    try { body = JSON.parse(cause.responseBody ?? ''); } catch { /* The status alone still picks a message. */ }
    const rejection = z.object({ error: z.object({ code: z.string().optional() }) }).safeParse(body);
    return new Error(chatGptError(cause.statusCode, rejection.success ? rejection.data.error.code : undefined));
  }
  // The user's own cancellation was rethrown above, so an abort here is the loop's stalled-stream timeout.
  if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) return new Error('Agent model endpoint: The endpoint stopped responding. The request timed out.');
  return new Error('Agent model endpoint: The agent could not complete the response. Try again.');
}
