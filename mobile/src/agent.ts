import { z } from 'zod';
import { MCPConnection, jsonObjectSchema, type MCPTool } from './mcp';
import { bearerHeaders, parseResponse, readJSON, request, type Fetch } from './network';
import { toolApprovalPolicy, type MobileSettings } from './settings';
import { chatGptEndpoint, chatGptError } from './chatgpt';

// Keep this prefix and assembly identical to desktop app/src/agent/runtime.ts.
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

function buildSystemPrompt(customInstructions: string): string {
  const userInstructions = customInstructions.trim();
  if (!userInstructions) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}

<user_instructions>
The user wrote these standing instructions. Follow them unless they conflict with approval_handling or tool policies.
${userInstructions}
</user_instructions>`;
}

function runtimeContext(): string {
  const now = new Date();
  return `<runtime_context>
- Current local datetime: ${new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' }).format(now)}
- Current UTC datetime: ${now.toISOString()}
- Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}
- Use this datetime context when interpreting relative dates like today, tomorrow, yesterday, tonight, this week, current year, or latest.
</runtime_context>`;
}

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
type ResponseInput = { role: 'system' | 'developer' | 'user' | 'assistant'; content: string | Text[] }
  | { type: 'reasoning'; id: string; encrypted_content?: string | null; summary: unknown[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string | Text[] };
type AvailableTool = { connection: MCPConnection; tool: MCPTool };

export async function runAgent({ transcript, settings, signal, fetch, onStatus, approve, getChatGptAccessToken }: {
  transcript: string; settings: MobileSettings; signal: AbortSignal; fetch: Fetch;
  onStatus: (status: string, completedSteps: number) => void;
  approve: (request: ToolApproval) => Promise<boolean>;
  getChatGptAccessToken?: () => Promise<string>;
}): Promise<string> {
  if (!settings.agentEnabled) throw new Error('Enable Agent Mode in Settings first.');
  if (!transcript.trim()) throw new Error('Record a command first.');
  // Custom servers may run without a key even when a header mode is saved; hosted providers never do.
  const chatgpt = settings.agentProvider === 'chatgpt';
  if (!chatgpt && settings.agentProvider !== 'openai-compatible' && settings.agentAuth !== 'none' && !settings.agentKey) throw new Error('Enter the agent provider API key in Settings.');
  if (chatgpt && !getChatGptAccessToken) throw new Error('Sign in with ChatGPT in Settings.');
  // Name the failing stage; "could not reach the endpoint" alone doesn't say whether the model or an MCP server failed.
  let completedSteps = 0;
  const status = (message: string) => onStatus(message, completedSteps);
  const stage = <T>(label: string, work: Promise<T>) => work.then(result => { completedSteps++; return result; }).catch((error: unknown) => {
    if (signal.aborted || !(error instanceof Error)) throw error;
    throw new Error(`${label}: ${error.message}`);
  });
  const responses = chatgpt || settings.agentApiMode === 'responses';
  const system = buildSystemPrompt(settings.customInstructions);
  const command = `${runtimeContext()}\n\n${transcript}`;
  const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: command }];
  const input: ResponseInput[] = [{ role: chatgpt ? 'developer' : 'system', content: system }, { role: 'user', content: command }];
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
        model: settings.agentModel, stream: chatgpt, ...reasoningOptions(settings),
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
      const data = await stage('Agent model endpoint', chatgpt && getChatGptAccessToken
        ? requestChatGpt({ fetch, body, signal, token: await getChatGptAccessToken() })
        : request({ fetch, endpoint: settings.agentEndpoint, allowHTTP: settings.allowInsecureHTTP, signal,
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

const chatGptRejectionSchema = z.object({ error: z.object({ code: z.string().optional(), param: z.string().optional() }) });
const streamEventSchema = z.object({ type: z.string(), response: z.unknown().optional(), code: z.string().optional(),
  error: z.object({ code: z.string().optional() }).optional() });

async function requestChatGpt({ fetch, body, signal, token }: {
  fetch: Fetch; body: Record<string, unknown>; signal: AbortSignal; token: string;
}): Promise<unknown> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 90_000);
  let response: Response | undefined;
  try {
    const send = () => fetch(chatGptEndpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: controller.signal, redirect: 'error', credentials: 'omit' });
    response = await send();
    if (response.status === 400 && body.include !== undefined) {
      const rejection = chatGptRejectionSchema.safeParse(await readJSON(response).catch(() => null));
      if (rejection.success && /^include(?:\[|\.|$)/.test(rejection.data.error.param ?? '')) {
        delete body.include;
        await response.body?.cancel().catch(() => {});
        response = await send();
      } else throw new Error(chatGptError(400, rejection.success ? rejection.data.error.code : undefined));
    }
    if (!response.ok) {
      const rejection = chatGptRejectionSchema.safeParse(await readJSON(response).catch(() => null));
      throw new Error(chatGptError(response.status, rejection.success ? rejection.data.error.code : undefined));
    }
    return await readChatGptStream(response, controller.signal);
  } catch (error) {
    signal.throwIfAborted();
    if (controller.signal.aborted) throw new Error('ChatGPT stopped responding. The request timed out.');
    if (!response || error instanceof TypeError) throw new Error('Could not reach ChatGPT. Check your connection and try again.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    await response?.body?.cancel().catch(() => {});
  }
}

/** Deltas are provisional. Only the final completed event may finish a run or authorize tool calls. */
async function readChatGptStream(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error('ChatGPT returned an empty response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  const parseEvent = (frame: string): z.infer<typeof streamEventSchema> | null => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return null;
    try { return streamEventSchema.parse(JSON.parse(data)); }
    catch { throw new Error('ChatGPT returned an invalid stream event.'); }
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      bytes += chunk.value?.byteLength ?? 0;
      if (bytes > 8_000_000) throw new Error('The ChatGPT response is too large.');
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1 || (chunk.done && buffer.length > 0)) {
        if (end === -1) end = buffer.length;
        const event = parseEvent(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event?.type === 'response.completed' || event?.type === 'response.incomplete') return event.response;
        if (event?.type === 'error' || event?.type === 'response.failed') {
          const failed = z.object({ error: z.object({ code: z.string().optional() }).nullable().optional() }).safeParse(event.response);
          throw new Error(chatGptError(400, event.code ?? event.error?.code ?? (failed.success ? failed.data.error?.code : undefined)));
        }
      }
      if (buffer.length > 2_000_000) throw new Error('The ChatGPT stream event is too large.');
      if (chunk.done) throw new Error('ChatGPT disconnected before completing the response. Try again.');
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
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
