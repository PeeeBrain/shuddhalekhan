import { z } from 'zod';
import { bearerHeaders, parseResponse, readJSON, request, type Fetch } from './network';
import type { MCPServerSettings } from './settings';

export const jsonObjectSchema = z.record(z.string(), z.json());
export type JSONObject = z.infer<typeof jsonObjectSchema>;
const envelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.json().optional(),
  error: z.object({ code: z.number() }).passthrough().optional(),
}).passthrough();
const toolSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(8000).optional(),
  inputSchema: jsonObjectSchema.refine(value => value.type === 'object', 'Expected an object schema.'),
});
export type MCPTool = z.infer<typeof toolSchema>;

/** Stream POST replies until our JSON-RPC id arrives; servers need not close their SSE stream. */
async function readReply(response: Response, id: number, signal: AbortSignal): Promise<unknown> {
  const check = (data: unknown) => {
    const envelope = parseResponse(envelopeSchema, data);
    if (envelope.id !== id) return { matched: false as const };
    if (envelope.error) throw new Error(`MCP request failed (code ${envelope.error.code}).`);
    if (envelope.result === undefined) throw new Error('MCP returned a response without a result.');
    return { matched: true as const, result: envelope.result };
  };
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const reply = check(await readJSON(response));
    if (!reply.matched) throw new Error('MCP returned a response for a different request.');
    return reply.result;
  }
  if (!response.body) throw new Error('MCP returned an empty event stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let event: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2_000_000) throw new Error('The MCP response is too large.');
      pending += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        if (line.startsWith('data:')) event.push(line.slice(5).replace(/^ /, ''));
        if (line === '' && event.length) {
          const data = event.join('\n');
          event = [];
          if (!data.trim()) continue;
          let message: unknown;
          try { message = JSON.parse(data); } catch { throw new Error('MCP returned invalid event data.'); }
          const reply = check(message);
          if (reply.matched) return reply.result;
        }
      }
    }
    throw new Error('MCP disconnected before replying. The tool may still have run.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class MCPConnection {
  private sequence = 0;
  private sessionId: string | null = null;
  private protocol = '2025-11-25';

  constructor(readonly server: MCPServerSettings, private readonly fetch: Fetch, private readonly allowHTTP: boolean) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...bearerHeaders(this.server.token),
      'MCP-Protocol-Version': this.protocol,
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
    };
  }

  private async rpc(method: string, params: JSONObject, signal: AbortSignal): Promise<unknown> {
    const id = ++this.sequence;
    return request({ fetch: this.fetch, endpoint: this.server.endpoint, allowHTTP: this.allowHTTP, signal,
      init: { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) },
      read: async (response, requestSignal) => {
        if (method === 'initialize') {
          this.sessionId = response.headers.get('mcp-session-id');
          if (this.sessionId && !/^[\x21-\x7e]{1,1024}$/.test(this.sessionId)) throw new Error('MCP returned an invalid session ID.');
        }
        return readReply(response, id, requestSignal);
      },
    });
  }

  async connect(signal: AbortSignal): Promise<MCPTool[]> {
    const initialized = parseResponse(z.object({
      protocolVersion: z.enum(['2025-03-26', '2025-06-18', '2025-11-25']),
      capabilities: z.object({ tools: z.object({}).optional() }),
    }), await this.rpc('initialize', { protocolVersion: this.protocol, capabilities: {}, clientInfo: { name: 'Shuddhalekhan Mobile', version: '1.0.0' } }, signal));
    this.protocol = initialized.protocolVersion;
    await request({ fetch: this.fetch, endpoint: this.server.endpoint, allowHTTP: this.allowHTTP, signal,
      init: { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) },
      read: async () => undefined,
    });
    if (!initialized.capabilities.tools) return [];
    const tools: MCPTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = parseResponse(z.object({ tools: z.array(toolSchema).max(256), nextCursor: z.string().max(4096).optional() }),
        await this.rpc('tools/list', cursor ? { cursor } : {}, signal));
      tools.push(...page.tools);
      if (tools.length > 256) throw new Error('An MCP server exposes too many tools (maximum 256).');
      cursor = page.nextCursor;
      if (cursor !== undefined && cursors.has(cursor)) throw new Error('MCP repeated a tool-list cursor.');
      if (cursor !== undefined) cursors.add(cursor);
    } while (cursor !== undefined);
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('MCP returned duplicate tool names.');
    return tools;
  }

  async call(name: string, args: JSONObject, signal: AbortSignal): Promise<string> {
    const result = parseResponse(z.object({ content: z.array(z.json()), isError: z.boolean().optional(), structuredContent: z.json().optional() }),
      await this.rpc('tools/call', { name, arguments: args }, signal));
    return JSON.stringify(result);
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await request({ fetch: this.fetch, endpoint: this.server.endpoint, allowHTTP: this.allowHTTP, signal: new AbortController().signal, timeoutMs: 3000,
        init: { method: 'DELETE', headers: this.headers() }, read: async () => undefined });
    } catch { /* Session termination is optional and cannot replace the run's real outcome. */ }
    this.sessionId = null;
  }
}
