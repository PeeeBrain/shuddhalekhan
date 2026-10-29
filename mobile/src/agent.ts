import { z } from 'zod';
import { MCPConnection, jsonObjectSchema, type MCPTool } from './mcp';
import { bearerHeaders, parseResponse, readJSON, request, type Fetch } from './network';
import { toolApprovalPolicy, type MobileSettings } from './settings';

export type ToolApproval = { serverName: string; toolName: string; arguments: string };
type ToolCall = { id: string; name: string; arguments: string };

const toolCallSchema = z.object({ id: z.string().min(1).max(200), type: z.literal('function'),
  function: z.object({ name: z.string().min(1).max(100), arguments: z.string().max(100_000) }) });
const chatMessageSchema = z.object({ role: z.literal('assistant'), content: z.string().max(200_000).nullable().optional(),
  tool_calls: z.array(toolCallSchema).max(16).optional(),
  // Reasoning models (OpenRouter, DeepSeek, vLLM) need their reasoning echoed back to continue after a tool call.
  reasoning_details: z.array(z.unknown()).max(100).optional(), reasoning_content: z.string().max(200_000).nullable().optional() });
const completionSchema = z.object({ choices: z.array(z.object({ message: chatMessageSchema, finish_reason: z.string().nullable().optional() })).min(1) });

const responseItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reasoning'), id: z.string().min(1).max(200), encrypted_content: z.string().max(200_000).nullable().optional(),
    summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string().max(200_000) })).max(100).default([]) }),
  z.object({ type: z.literal('function_call'), call_id: z.string().min(1).max(200), name: z.string().min(1).max(100), arguments: z.string().max(100_000) }),
  z.object({ type: z.literal('message'), role: z.literal('assistant'), content: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('output_text'), text: z.string().max(200_000) }),
    z.object({ type: z.literal('refusal'), refusal: z.string().max(200_000) }),
  ])).max(100) }),
]);
const responsesSchema = z.object({
  status: z.string(),
  incomplete_details: z.object({ reason: z.string().max(100) }).nullable().optional(),
  // Ignore output items this harness never requests (web search, images) instead of failing the run.
  output: z.array(z.unknown()).max(100).transform(items => items.flatMap(item => {
    const parsed = responseItemSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  })),
});

type Text = { type: string; text: string; [key: string]: unknown };
type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null | Text[]; tool_calls?: z.infer<typeof toolCallSchema>[];
  tool_call_id?: string; reasoning_details?: unknown[]; reasoning_content?: string | null };
type ResponseInput = { role: 'system' | 'user' | 'assistant'; content: string | Text[] }
  | { type: 'reasoning'; id: string; encrypted_content?: string | null; summary: unknown[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string | Text[] };
type AvailableTool = { connection: MCPConnection; tool: MCPTool };

export async function runAgent({ transcript, settings, signal, fetch, onStatus, approve }: {
  transcript: string; settings: MobileSettings; signal: AbortSignal; fetch: Fetch;
  onStatus: (status: string, completedSteps: number) => void;
  approve: (request: ToolApproval) => Promise<boolean>;
}): Promise<string> {
  if (!settings.agentEnabled) throw new Error('Enable Agent Mode in Settings first.');
  if (!transcript.trim()) throw new Error('Record a command first.');
  // Custom servers may run without a key even when a header mode is saved; hosted providers never do.
  if (settings.agentProvider !== 'openai-compatible' && settings.agentAuth !== 'none' && !settings.agentKey) throw new Error('Enter the agent provider API key in Settings.');
  // Name the failing stage; "could not reach the endpoint" alone doesn't say whether the model or an MCP server failed.
  let completedSteps = 0;
  const status = (message: string) => onStatus(message, completedSteps);
  const stage = <T>(label: string, work: Promise<T>) => work.then(result => { completedSteps++; return result; }).catch((error: unknown) => {
    if (signal.aborted || !(error instanceof Error)) throw error;
    throw new Error(`${label}: ${error.message}`);
  });
  const responses = settings.agentApiMode === 'responses';
  const system = `${settings.systemPrompt}\nThis is a single command, without prior conversation. Local date: ${new Date().toLocaleString()}.`;
  const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: transcript }];
  const input: ResponseInput[] = [{ role: 'system', content: system }, { role: 'user', content: transcript }];
  const connections: MCPConnection[] = [];
  const available = new Map<string, AvailableTool>();
  const usedCallIds = new Set<string>();
  try {
    for (const server of settings.mcpServers.filter(server => server.enabled)) {
      signal.throwIfAborted();
      status(`Connecting to ${server.name}…`);
      const connection = new MCPConnection(server, fetch, settings.allowInsecureHTTP);
      connections.push(connection);
      const tools = await stage(`MCP server "${server.name}"`, connection.connect(signal));
      for (const [index, tool] of tools.entries()) {
        if (toolApprovalPolicy(server, tool.name) !== 'disabled') available.set(`mcp_${connections.length}_${index}`, { connection, tool });
      }
      if (available.size > 256) throw new Error('Too many enabled MCP tools (maximum 256).');
    }
    const tools = [...available].map(([name, { tool, connection }]) => ({
      name, description: `${connection.server.name}: ${tool.name}. ${tool.description ?? ''}`, parameters: tool.inputSchema,
    }));
    let toolCalls = 0;
    for (let step = 0; step < 8; step++) {
      signal.throwIfAborted();
      status('Waiting for the agent…');
      const body = {
        model: settings.agentModel, stream: false, ...reasoningOptions(settings),
        ...(responses ? { input: withCache(settings, input), store: false, include: ['reasoning.encrypted_content'] } : { messages: withCache(settings, messages) }),
        ...(nativeCache(settings) ? { prompt_cache_key: 'shuddhalekhan-mobile-agent-v1' } : {}),
        ...(tools.length ? {
          tools: responses ? tools.map(tool => ({ type: 'function', ...tool, strict: false })) : tools.map(tool => ({ type: 'function', function: tool })),
          parallel_tool_calls: false,
        } : {}),
      };
      const auth = settings.agentAuth === 'none' ? {} : settings.agentAuth === 'api-key' ? { 'api-key': settings.agentKey } : bearerHeaders(settings.agentKey);
      const openRouter: Record<string, string> = settings.agentProvider === 'openrouter'
        ? { 'HTTP-Referer': 'https://github.com/parthashirolkar/shuddhalekhan', 'X-OpenRouter-Title': 'Shuddhalekhan' } : {};
      const data = await stage('Agent model endpoint', request({ fetch, endpoint: settings.agentEndpoint, allowHTTP: settings.allowInsecureHTTP, signal,
        init: { method: 'POST', headers: { 'Content-Type': 'application/json', ...openRouter, ...auth }, body: JSON.stringify(body) }, read: readJSON }));

      let text: string;
      let calls: ToolCall[];
      if (responses) {
        const response = parseResponse(responsesSchema, data);
        if (response.status === 'incomplete') throw new Error(response.incomplete_details?.reason === 'max_output_tokens'
          ? 'The agent reached its output limit. Try a shorter command.' : 'The agent stopped before finishing. Try again.');
        if (response.status !== 'completed') throw new Error('The agent did not complete the response. Try again.');
        const texts: string[] = [];
        calls = [];
        // Stateless continuation in output order, shaped as the AI SDK sends it with store: false.
        for (const item of response.output) {
          if (item.type === 'reasoning') input.push({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: item.summary });
          else if (item.type === 'function_call') {
            input.push({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments });
            calls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
          } else {
            const content = item.content.map(part => part.type === 'output_text' ? part.text : part.refusal).join('');
            input.push({ role: 'assistant', content });
            texts.push(content);
          }
        }
        text = texts.join('\n');
      } else {
        const choice = parseResponse(completionSchema, data).choices[0]!;
        if (choice.finish_reason === 'length') throw new Error('The agent reached its output limit. Try a shorter command.');
        text = choice.message.content ?? '';
        calls = (choice.message.tool_calls ?? []).map(call => ({ id: call.id, ...call.function }));
        if (calls.length) messages.push({ ...choice.message, content: choice.message.content ?? null });
      }
      if (!calls.length) {
        if (!text.trim()) throw new Error('The agent returned an empty response.');
        status('Agent finished.');
        return text.trim();
      }
      for (const call of calls) {
        if (usedCallIds.has(call.id)) throw new Error('The agent returned duplicate tool-call IDs.');
        usedCallIds.add(call.id);
      }
      for (const call of calls) {
        signal.throwIfAborted();
        if (++toolCalls > 16) throw new Error('The agent reached the tool-call limit. Completed actions may already have taken effect.');
        const selected = available.get(call.name);
        if (!selected) throw new Error('The agent requested an unavailable tool.');
        let raw: unknown;
        try { raw = JSON.parse(call.arguments); } catch { throw new Error('The agent returned invalid tool arguments.'); }
        const args = parseResponse(jsonObjectSchema, raw);
        if (toolApprovalPolicy(selected.connection.server, selected.tool.name) !== 'alwaysAllow') {
          status('Waiting for your tool approval…');
          const approved = await approve({ serverName: selected.connection.server.name, toolName: selected.tool.name, arguments: JSON.stringify(args, null, 2) });
          signal.throwIfAborted();
          if (!approved) throw new Error('Tool denied. The agent run stopped. Earlier approved actions may already have completed.');
        }
        signal.throwIfAborted();
        status(`Running ${selected.connection.server.name} / ${selected.tool.name}…`);
        const result = await stage(`MCP server "${selected.connection.server.name}"`, selected.connection.call(selected.tool.name, args, signal));
        signal.throwIfAborted();
        if (result.length > 100_000) throw new Error('The tool result is too large. The action may already have completed.');
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        input.push({ type: 'function_call_output', call_id: call.id, output: result });
      }
    }
    throw new Error('The agent reached its step limit. Completed actions may already have taken effect.');
  } finally {
    await Promise.allSettled(connections.map(connection => connection.close()));
  }
}

function reasoningOptions(settings: MobileSettings) {
  const effort = settings.agentReasoning;
  if (effort === 'default') return {};
  if (settings.agentProvider === 'openrouter') return { reasoning: effort === 'none' ? { enabled: false } : { effort } };
  if (settings.agentApiMode === 'responses') return { reasoning: { effort } };
  return { reasoning_effort: effort, ...(isDeepSeekV4(settings) ? { thinking: { type: effort === 'none' ? 'disabled' : 'enabled' } } : {}) };
}

function isDeepSeekV4(settings: MobileSettings): boolean {
  try {
    const url = new URL(settings.agentEndpoint);
    return settings.agentProvider === 'openai-compatible'
      && (url.hostname === 'api.deepseek.com' || (url.hostname === 'opencode.ai' && url.pathname.startsWith('/zen/')))
      && (settings.agentModel === 'deepseek-v4-flash' || settings.agentModel === 'deepseek-v4-pro');
  } catch { return false; }
}

function nativeCache(settings: MobileSettings): boolean {
  return settings.agentCache && (settings.agentProvider === 'openai' || settings.agentProvider === 'azure-openai');
}

/**
 * Marks the system prompt and the latest two inputs (user command or tool result), matching desktop:
 * OpenRouter always gets ephemeral cache_control; OpenAI/Azure get explicit breakpoints when enabled.
 * Copies the request so stale markers never accumulate on earlier turns.
 */
function withCache<T extends ChatMessage | ResponseInput>(settings: MobileSettings, items: T[]): T[] {
  const marker = settings.agentProvider === 'openrouter' ? { cache_control: { type: 'ephemeral' } }
    : nativeCache(settings) ? { prompt_cache_breakpoint: { mode: 'explicit' } } : null;
  if (!marker) return items;
  const textType = settings.agentApiMode === 'responses' ? 'input_text' : 'text';
  const inputs = items.flatMap((item, index) => 'role' in item && (item.role === 'user' || item.role === 'tool')
    || 'type' in item && item.type === 'function_call_output' ? [index] : []).slice(-2);
  return items.map((item, index) => {
    if (index !== 0 && !inputs.includes(index)) return item;
    const content = 'output' in item ? item.output : 'content' in item ? item.content : null;
    if (typeof content !== 'string') return item;
    const marked = [{ type: textType, text: content, ...marker }];
    return 'output' in item ? { ...item, output: marked } : { ...item, content: marked };
  });
}
