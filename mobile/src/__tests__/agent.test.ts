import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { runAgent } from '../agent';
import { MCPConnection } from '../mcp';
import { defaultSettings, mobileSettingsSchema, type MobileSettings, type MCPServerSettings } from '../settings';

const rpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number().optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

async function withServer<T>(
  handler: (request: Request) => Response | Promise<Response>,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  try {
    return await run(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop(true);
  }
}

function errorFrom<T>(promise: Promise<T>): Promise<Error> {
  return promise.then(
    () => { throw new Error('Expected the request to fail.'); },
    error => {
      if (error instanceof Error) return error;
      throw new Error('The request failed without an Error object.');
    },
  );
}

function agentSettings(providerUrl: string, mcpUrl: string): MobileSettings {
  return {
    ...defaultSettings,
    agentEnabled: true,
    agentEndpoint: `${providerUrl}/v1/chat/completions`,
    agentModel: 'test-model',
    agentKey: 'provider-secret',
    allowInsecureHTTP: true,
    mcpServers: [{
      id: 'test-mcp',
      name: 'Test Tools',
      endpoint: `${mcpUrl}/mcp`,
      token: 'mcp-secret',
      enabled: true,
    }],
  };
}

type MCPFixtureState = {
  requests: Array<{ method: string; protocol: string | null; session: string | null; authorization: string | null }>;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  closes: number;
};

function agentMCPHandler(state: MCPFixtureState) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'DELETE') {
      state.closes++;
      state.requests.push({
        method: 'DELETE',
        protocol: request.headers.get('mcp-protocol-version'),
        session: request.headers.get('mcp-session-id'),
        authorization: request.headers.get('authorization'),
      });
      return new Response(null, { status: 202 });
    }

    const body = rpcRequestSchema.parse(await request.json());
    state.requests.push({
      method: body.method,
      protocol: request.headers.get('mcp-protocol-version'),
      session: request.headers.get('mcp-session-id'),
      authorization: request.headers.get('authorization'),
    });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.id === undefined) return Response.json({ error: 'Expected a JSON-RPC request id.' }, { status: 400 });
    if (body.method === 'initialize') {
      return Response.json({
        jsonrpc: '2.0', id: body.id,
        result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } },
      }, { headers: { 'Mcp-Session-Id': 'agent-session' } });
    }
    if (body.method === 'tools/list') {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [{
        name: 'search',
        description: 'Search user documents',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }] } });
    }
    if (body.method === 'tools/call') {
      const params = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }).parse(body.params);
      state.calls.push(params);
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'A matching document was found.' }] } });
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Unknown method' } });
  };
}

function newMCPFixtureState(): MCPFixtureState {
  return { requests: [], calls: [], closes: 0 };
}

const modelRequestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({
    role: z.string(),
    content: z.unknown(),
    tool_call_id: z.string().optional(),
  }).passthrough()),
  tools: z.array(z.object({ type: z.literal('function'), function: z.object({ name: z.string() }).passthrough() })).optional(),
  parallel_tool_calls: z.boolean().optional(),
}).passthrough();

function toolCallResponse(): Response {
  return Response.json({ choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-search-1',
        type: 'function',
        function: { name: 'mcp_1_0', arguments: '{"query":"quarterly plan"}' },
      }],
    },
    finish_reason: 'tool_calls',
  }] });
}

describe('agent HTTP and MCP flow', () => {
  test('discovers MCP tools across pages and returns a correlated SSE reply while the stream stays open', async () => {
    const requests: Array<{
      method: string;
      id?: number;
      cursor?: unknown;
      initializeProtocol?: unknown;
      protocol: string | null;
      session: string | null;
      authorization: string | null;
      accept: string | null;
    }> = [];
    let streamCancelled = false;
    const encoder = new TextEncoder();
    await withServer(async request => {
      if (request.method === 'DELETE') {
        requests.push({
          method: 'DELETE', protocol: request.headers.get('mcp-protocol-version'),
          session: request.headers.get('mcp-session-id'), authorization: request.headers.get('authorization'),
          accept: request.headers.get('accept'),
        });
        return new Response(null, { status: 202 });
      }
      const body = rpcRequestSchema.parse(await request.json());
      requests.push({
        method: body.method, id: body.id, cursor: body.params?.cursor,
        initializeProtocol: body.params?.protocolVersion,
        protocol: request.headers.get('mcp-protocol-version'), session: request.headers.get('mcp-session-id'),
        authorization: request.headers.get('authorization'), accept: request.headers.get('accept'),
      });
      if (body.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0', id: body.id,
          result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } },
        }, { headers: { 'Mcp-Session-Id': 'discovery-session' } });
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'tools/list' && body.params?.cursor === undefined) {
        const bodyStream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode([
              ': heartbeat\n\n',
              'event: message\ndata: {"jsonrpc":"2.0","id":999,"result":{"tools":[]}}\n\n',
              'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":0.5}}\n\n',
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: '2.0', id: body.id,
                result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }], nextCursor: 'page-two' },
              })}\n\n`,
            ].join('')));
          },
          cancel() { streamCancelled = true; },
        });
        return new Response(bodyStream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (body.method === 'tools/list') {
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] } });
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601 } });
    }, async url => {
      const server: MCPServerSettings = { id: 'discovery', name: 'Discovery', endpoint: `${url}/mcp`, token: 'discovery-secret', enabled: true };
      const connection = new MCPConnection(server, globalThis.fetch, true);
      const tools = await connection.connect(new AbortController().signal);
      await connection.close();

      expect(tools.map(tool => tool.name)).toEqual(['search', 'lookup']);
      expect(streamCancelled).toBe(true);
      expect(requests.map(item => item.method)).toEqual([
        'initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE',
      ]);
      expect(requests[0]?.protocol).toBe('2025-11-25');
      expect(requests[0]?.initializeProtocol).toBe('2025-11-25');
      expect(requests[0]?.session).toBeNull();
      expect(requests[0]?.authorization).toBe('Bearer discovery-secret');
      expect(requests[0]?.accept).toContain('text/event-stream');
      expect(requests[1]?.id).toBeUndefined();
      expect(requests[2]?.protocol).toBe('2025-06-18');
      expect(requests[2]?.session).toBe('discovery-session');
      expect(requests[3]?.cursor).toBe('page-two');
      expect(requests[4]?.protocol).toBe('2025-06-18');
      expect(requests[4]?.session).toBe('discovery-session');
    });
  });

  test('approves an MCP tool call, sends its result back to the model, and returns the continuation', async () => {
    const mcpState = newMCPFixtureState();
    let modelRequests = 0;
    const providerRequests: Array<{ authorization: string | null; body: z.infer<typeof modelRequestSchema> }> = [];
    const approvals: Array<{ serverName: string; toolName: string; arguments: string }> = [];
    await withServer(request => agentMCPHandler(mcpState)(request), async mcpUrl => {
      await withServer(async request => {
        const body = modelRequestSchema.parse(await request.json());
        providerRequests.push({ authorization: request.headers.get('authorization'), body });
        modelRequests++;
        return modelRequests === 1
          ? toolCallResponse()
          : Response.json({ choices: [{ message: { role: 'assistant', content: 'I found the quarterly plan.' }, finish_reason: 'stop' }] });
      }, async providerUrl => {
        const answer = await runAgent({
          transcript: 'Find the quarterly plan.',
          settings: agentSettings(providerUrl, mcpUrl),
          signal: new AbortController().signal,
          fetch: globalThis.fetch,
          onStatus: () => {},
          approve: async approval => {
            approvals.push(approval);
            return true;
          },
        });

        expect(answer).toBe('I found the quarterly plan.');
        expect(approvals).toEqual([{ serverName: 'Test Tools', toolName: 'search', arguments: '{\n  "query": "quarterly plan"\n}' }]);
        expect(modelRequests).toBe(2);
        expect(providerRequests.map(item => item.authorization)).toEqual(['Bearer provider-secret', 'Bearer provider-secret']);
        expect(providerRequests[0]?.body.model).toBe('test-model');
        expect(providerRequests[0]?.body.tools?.map(tool => tool.function.name)).toEqual(['mcp_1_0']);
        expect(providerRequests[0]?.body.parallel_tool_calls).toBe(false);
        const toolResult = providerRequests[1]?.body.messages.find(message => message.role === 'tool');
        expect(toolResult?.tool_call_id).toBe('call-search-1');
        expect(toolResult?.content).toContain('A matching document was found.');
        expect(mcpState.calls).toEqual([{ name: 'search', arguments: { query: 'quarterly plan' } }]);
        expect(mcpState.requests.map(item => item.method)).toEqual([
          'initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'DELETE',
        ]);
        expect(mcpState.requests.every(item => item.authorization === 'Bearer mcp-secret')).toBe(true);
        expect(mcpState.closes).toBe(1);
      });
    });
  });

  test('a denied tool never reaches the MCP server and closes its session', async () => {
    const mcpState = newMCPFixtureState();
    await withServer(request => agentMCPHandler(mcpState)(request), async mcpUrl => {
      await withServer(() => toolCallResponse(), async providerUrl => {
        const failure = await errorFrom(runAgent({
          transcript: 'Search something.',
          settings: agentSettings(providerUrl, mcpUrl),
          signal: new AbortController().signal,
          fetch: globalThis.fetch,
          onStatus: () => {},
          approve: async () => false,
        }));
        expect(failure.message).toBe('Tool denied. The agent run stopped. Earlier approved actions may already have completed.');
        expect(mcpState.calls).toHaveLength(0);
        expect(mcpState.closes).toBe(1);
      });
    });
  });

  test('saved auto-approval applies only to that server and leaves another server asking', async () => {
    const allowed = newMCPFixtureState();
    const asking = newMCPFixtureState();
    const approvals: string[] = [];
    await withServer(agentMCPHandler(allowed), async allowedUrl => {
      await withServer(agentMCPHandler(asking), async askingUrl => {
        let step = 0;
        await withServer(() => {
          step++;
          return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
            id: `call-${step}`, type: 'function', function: { name: `mcp_${step}_0`, arguments: '{"query":"plan"}' },
          }] }, finish_reason: 'tool_calls' }] });
        }, async providerUrl => {
          const base = agentSettings(providerUrl, allowedUrl);
          const settings = mobileSettingsSchema.parse({ ...base, mcpServers: [
            { ...base.mcpServers[0], toolPolicies: { search: 'alwaysAllow' } },
            { ...base.mcpServers[0], id: 'other', name: 'Other Tools', endpoint: `${askingUrl}/mcp` },
          ] });
          const failure = await errorFrom(runAgent({ transcript: 'Find a plan.', settings,
            signal: new AbortController().signal, fetch: globalThis.fetch, onStatus: () => {},
            approve: async approval => { approvals.push(approval.serverName); return false; },
          }));
          expect(failure.message).toContain('Tool denied');
          expect(allowed.calls).toEqual([{ name: 'search', arguments: { query: 'plan' } }]);
          expect(asking.calls).toHaveLength(0);
          expect(approvals).toEqual(['Other Tools']);
          expect(allowed.closes).toBe(1);
          expect(asking.closes).toBe(1);
        });
      });
    });
  });

  test('disabled tools are not advertised and a guessed call cannot execute them', async () => {
    const mcp = newMCPFixtureState();
    let advertised: string[] = [];
    let approvals = 0;
    await withServer(agentMCPHandler(mcp), async mcpUrl => {
      await withServer(async request => {
        const body = modelRequestSchema.parse(await request.json());
        advertised = (body.tools ?? []).map(tool => tool.function.name);
        return toolCallResponse();
      }, async providerUrl => {
        const base = agentSettings(providerUrl, mcpUrl);
        const settings = mobileSettingsSchema.parse({ ...base, mcpServers: base.mcpServers.map(server => ({
          ...server, toolPolicies: { search: 'disabled' },
        })) });
        const failure = await errorFrom(runAgent({ transcript: 'Search.', settings,
          signal: new AbortController().signal, fetch: globalThis.fetch, onStatus: () => {},
          approve: async () => { approvals++; return true; },
        }));
        expect(failure.message).toContain('unavailable tool');
        expect(advertised).toEqual([]);
        expect(approvals).toBe(0);
        expect(mcp.calls).toHaveLength(0);
        expect(mcp.closes).toBe(1);
      });
    });
  });

  test('cancelling during pending approval prevents the tool call and closes its session', async () => {
    const mcpState = newMCPFixtureState();
    await withServer(request => agentMCPHandler(mcpState)(request), async mcpUrl => {
      await withServer(() => toolCallResponse(), async providerUrl => {
        const controller = new AbortController();
        let approvalStarted = () => {};
        const approvalStartedPromise = new Promise<void>(resolve => { approvalStarted = resolve; });
        let resolveApproval = (_approved: boolean) => {};
        const pendingApproval = new Promise<boolean>(resolve => { resolveApproval = resolve; });
        const run = runAgent({
          transcript: 'Search something.',
          settings: agentSettings(providerUrl, mcpUrl),
          signal: controller.signal,
          fetch: globalThis.fetch,
          onStatus: () => {},
          approve: () => {
            approvalStarted();
            return pendingApproval;
          },
        });

        await approvalStartedPromise;
        controller.abort();
        resolveApproval(true);
        const failure = await errorFrom(run);
        expect(failure.name).toBe('AbortError');
        expect(mcpState.calls).toHaveLength(0);
        expect(mcpState.closes).toBe(1);
      });
    });
  });
});

test('unreachable endpoints name the failing stage: agent model vs MCP server', async () => {
  const closed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const url = `http://127.0.0.1:${closed.port}`;
  await closed.stop(true);
  const run = (settings: MobileSettings) => errorFrom(runAgent({ transcript: 'hi', settings, signal: new AbortController().signal,
    fetch: globalThis.fetch, onStatus: () => {}, approve: async () => false }));
  const base = agentSettings(url, url);
  expect((await run({ ...base, mcpServers: [] })).message).toStartWith('Agent model endpoint: Could not reach the endpoint.');
  expect((await run(base)).message).toStartWith('MCP server "Test Tools": Could not reach the endpoint.');
});

describe('provider-specific agent continuation', () => {
  const toolResult = JSON.stringify({ content: [{ type: 'text', text: 'A matching document was found.' }] });
  const marked = (type: string, text: unknown) => [{ type, text, prompt_cache_breakpoint: { mode: 'explicit' } }];

  test('Responses runs echo reasoning and calls statelessly, correlate each approved result, and move cache breakpoints', async () => {
    const mcpState = newMCPFixtureState();
    const bodies: Array<Record<string, unknown> & { input: unknown[] }> = [];
    const keys: Array<string | null> = [];
    const step = (n: number) => ({ status: 'completed', output: [
      { type: 'reasoning', id: `rs-${n}`, encrypted_content: `opaque-${n}`, summary: [] },
      { type: 'web_search_call', id: 'ignored' },
      { type: 'function_call', id: `fc-${n}`, call_id: `call-${n}`, name: 'mcp_1_0', arguments: `{"query":"q${n}"}` },
    ] });
    await withServer(request => agentMCPHandler(mcpState)(request), async mcpUrl => {
      await withServer(async request => {
        bodies.push(await request.json() as (typeof bodies)[number]);
        keys.push(request.headers.get('api-key'));
        return Response.json(bodies.length < 3 ? step(bodies.length)
          : { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Both found.' }] }] });
      }, async providerUrl => {
        const approvals: string[] = [];
        const answer = await runAgent({
          transcript: 'Find two things.', signal: new AbortController().signal, fetch: globalThis.fetch, onStatus: () => {},
          settings: { ...agentSettings(providerUrl, mcpUrl), agentProvider: 'azure-openai', agentApiMode: 'responses', agentAuth: 'api-key',
            agentEndpoint: `${providerUrl}/openai/v1/responses`, agentReasoning: 'high', agentCache: true },
          approve: async approval => { approvals.push(approval.arguments); return true; },
        });
        expect(answer).toBe('Both found.');
        expect(approvals).toEqual(['{\n  "query": "q1"\n}', '{\n  "query": "q2"\n}']);
        expect(mcpState.calls.map(call => call.arguments)).toEqual([{ query: 'q1' }, { query: 'q2' }]);
        expect(keys).toEqual(['provider-secret', 'provider-secret', 'provider-secret']);
        expect(bodies[0]).toMatchObject({ store: false, include: ['reasoning.encrypted_content'], reasoning: { effort: 'high' },
          prompt_cache_key: 'shuddhalekhan-mobile-agent-v1' });
        const system = bodies[0]!.input[0];
        const result = (n: number) => ({ type: 'function_call_output', call_id: `call-${n}`, output: toolResult });
        const echoed = (n: number) => [
          { type: 'reasoning', id: `rs-${n}`, encrypted_content: `opaque-${n}`, summary: [] },
          { type: 'function_call', call_id: `call-${n}`, name: 'mcp_1_0', arguments: `{"query":"q${n}"}` },
        ];
        // The system prompt and the latest two inputs carry breakpoints; earlier inputs revert to plain strings.
        expect(bodies[2]!.input).toEqual([
          system,
          { role: 'user', content: 'Find two things.' },
          ...echoed(1), { ...result(1), output: marked('input_text', toolResult) },
          ...echoed(2), { ...result(2), output: marked('input_text', toolResult) },
        ]);
        expect(bodies[1]!.input[1]).toEqual({ role: 'user', content: marked('input_text', 'Find two things.') });
      });
    });
  });

  test('Chat Completions echoes OpenRouter reasoning details with the tool call so reasoning models can continue', async () => {
    const mcpState = newMCPFixtureState();
    const bodies: Array<{ messages: Array<Record<string, unknown>>; reasoning?: unknown }> = [];
    const referers: Array<string | null> = [];
    const details = [{ type: 'reasoning.encrypted', data: 'opaque' }];
    await withServer(request => agentMCPHandler(mcpState)(request), async mcpUrl => {
      await withServer(async request => {
        bodies.push(await request.json() as (typeof bodies)[number]);
        referers.push(request.headers.get('http-referer'));
        return bodies.length === 1
          ? Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_details: details,
            tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'mcp_1_0', arguments: '{"query":"plan"}' } }] } }] })
          : Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Found it.' } }] });
      }, async providerUrl => {
        const answer = await runAgent({
          transcript: 'Find the plan.', signal: new AbortController().signal, fetch: globalThis.fetch, onStatus: () => {}, approve: async () => true,
          settings: { ...agentSettings(providerUrl, mcpUrl), agentProvider: 'openrouter', agentReasoning: 'none' },
        });
        expect(answer).toBe('Found it.');
        expect(referers[0]).toBe('https://github.com/parthashirolkar/shuddhalekhan');
        expect(bodies[0]?.reasoning).toEqual({ enabled: false });
        expect(bodies[1]?.messages[2]).toMatchObject({ role: 'assistant', reasoning_details: details, tool_calls: [{ id: 'call-1' }] });
        expect(bodies[1]?.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call-1',
          content: [{ type: 'text', text: toolResult, cache_control: { type: 'ephemeral' } }] });
      });
    });
  });

  test('an incomplete Responses run reports the output limit instead of a partial answer', async () => {
    await withServer(() => Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Half an ans' }] }] }), async url => {
      const failure = await errorFrom(runAgent({
        transcript: 'Explain.', signal: new AbortController().signal, fetch: globalThis.fetch, onStatus: () => {}, approve: async () => true,
        settings: { ...agentSettings(url, url), mcpServers: [], agentApiMode: 'responses', agentEndpoint: `${url}/v1/responses` },
      }));
      expect(failure.message).toBe('The agent reached its output limit. Try a shorter command.');
    });
  });
});
