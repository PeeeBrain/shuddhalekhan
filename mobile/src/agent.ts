import { z } from 'zod';
import { MCPConnection, jsonObjectSchema, type MCPTool } from './mcp';
import { bearerHeaders, parseResponse, readJSON, request, type Fetch } from './network';
import type { MobileSettings } from './settings';

export type ToolApproval = { serverName: string; toolName: string; arguments: string };
const toolCallSchema = z.object({ id: z.string().min(1).max(200), type: z.literal('function'),
  function: z.object({ name: z.string().min(1).max(100), arguments: z.string().max(100_000) }) });
const messageSchema = z.object({ role: z.literal('assistant'), content: z.string().max(200_000).nullable().optional(),
  tool_calls: z.array(toolCallSchema).max(16).optional() });
const completionSchema = z.object({ choices: z.array(z.object({ message: messageSchema, finish_reason: z.string().nullable().optional() })).min(1) });
type Message = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: z.infer<typeof toolCallSchema>[]; tool_call_id?: string };
type AvailableTool = { connection: MCPConnection; tool: MCPTool; modelName: string };

export async function runAgent({ transcript, settings, signal, fetch, onStatus, approve }: {
  transcript: string; settings: MobileSettings; signal: AbortSignal; fetch: Fetch;
  onStatus: (status: string) => void;
  approve: (request: ToolApproval) => Promise<boolean>;
}): Promise<string> {
  if (!settings.agentEnabled) throw new Error('Enable Agent Mode in Settings first.');
  if (!transcript.trim()) throw new Error('Record a command first.');
  // Name the failing stage; "could not reach the endpoint" alone doesn't say whether the model or an MCP server failed.
  const stage = <T>(label: string, work: Promise<T>) => work.catch((error: unknown) => {
    if (signal.aborted || !(error instanceof Error)) throw error;
    throw new Error(`${label}: ${error.message}`);
  });
  const connections: MCPConnection[] = [];
  const available = new Map<string, AvailableTool>();
  const messages: Message[] = [
    { role: 'system', content: `${settings.systemPrompt}\nThis is a single command, without prior conversation. Local date: ${new Date().toLocaleString()}.` },
    { role: 'user', content: transcript },
  ];
  try {
    for (const server of settings.mcpServers.filter(server => server.enabled)) {
      signal.throwIfAborted();
      onStatus(`Connecting to ${server.name}…`);
      const connection = new MCPConnection(server, fetch, settings.allowInsecureHTTP);
      connections.push(connection);
      const tools = await stage(`MCP server "${server.name}"`, connection.connect(signal));
      for (const [index, tool] of tools.entries()) {
        const modelName = `mcp_${connections.length}_${index}`;
        available.set(modelName, { connection, tool, modelName });
      }
      if (available.size > 256) throw new Error('Too many enabled MCP tools (maximum 256).');
    }
    let toolCalls = 0;
    for (let step = 0; step < 8; step++) {
      signal.throwIfAborted();
      onStatus('Waiting for the agent…');
      const data = await stage('Agent model endpoint', request({ fetch, endpoint: settings.agentEndpoint, allowHTTP: settings.allowInsecureHTTP, signal,
        init: { method: 'POST', headers: { 'Content-Type': 'application/json', ...bearerHeaders(settings.agentKey) },
          body: JSON.stringify({ model: settings.agentModel, messages, stream: false,
            ...(available.size ? { tools: [...available.values()].map(({ tool, modelName, connection }) => ({ type: 'function', function: {
              name: modelName, description: `${connection.server.name}: ${tool.name}. ${tool.description ?? ''}`, parameters: tool.inputSchema,
            } })), parallel_tool_calls: false } : {}),
          }),
        }, read: readJSON }));
      const choice = parseResponse(completionSchema, data).choices[0];
      if (!choice) throw new Error('The agent returned no result.');
      if (choice.finish_reason === 'length') throw new Error('The agent reached its output limit. Try a shorter command.');
      const { message } = choice;
      if (!message.tool_calls?.length) {
        if (!message.content?.trim()) throw new Error('The agent returned an empty response.');
        return message.content.trim();
      }
      if (new Set(message.tool_calls.map(call => call.id)).size !== message.tool_calls.length) throw new Error('The agent returned duplicate tool-call IDs.');
      messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        signal.throwIfAborted();
        if (++toolCalls > 16) throw new Error('The agent reached the tool-call limit. Completed actions may already have taken effect.');
        const selected = available.get(call.function.name);
        if (!selected) throw new Error('The agent requested an unavailable tool.');
        let raw: unknown;
        try { raw = JSON.parse(call.function.arguments); } catch { throw new Error('The agent returned invalid tool arguments.'); }
        const args = parseResponse(jsonObjectSchema, raw);
        onStatus('Waiting for your tool approval…');
        const approved = await approve({ serverName: selected.connection.server.name, toolName: selected.tool.name, arguments: JSON.stringify(args, null, 2) });
        signal.throwIfAborted();
        if (!approved) throw new Error('Tool denied. The agent run stopped. Earlier approved actions may already have completed.');
        onStatus(`Running ${selected.connection.server.name} / ${selected.tool.name}…`);
        const result = await stage(`MCP server "${selected.connection.server.name}"`, selected.connection.call(selected.tool.name, args, signal));
        signal.throwIfAborted();
        if (result.length > 100_000) throw new Error('The tool result is too large. The action may already have completed.');
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
    throw new Error('The agent reached its step limit. Completed actions may already have taken effect.');
  } finally {
    await Promise.allSettled(connections.map(connection => connection.close()));
  }
}
