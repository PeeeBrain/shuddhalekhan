import { describe, expect, jest, test } from 'bun:test';
import { z } from 'zod';
import { runAgent } from '../agent';
import { MCPConnection } from '../mcp';
import { defaultSettings, mobileSettingsSchema, type MobileSettings, type MCPServerSettings } from '../settings';
import { chatReply } from './model-stream';

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
}).passthrough();

function toolCallResponse(): Response {
  return chatReply({ id: 'call-search-1', name: 'mcp_1_0', arguments: '{"query":"quarterly plan"}' });
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
              `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, method: 'ping' })}\n\n`,
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: '2.0', id: body.id,
                result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }], nextCursor: '' },
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
      expect(requests[3]?.cursor).toBe('');
      expect(requests[4]?.protocol).toBe('2025-06-18');
      expect(requests[4]?.session).toBe('discovery-session');
    });
  });

  test('approves an MCP tool call, sends its result back to the model, and returns the continuation', async () => {
    const mcpState = newMCPFixtureState();
    let modelRequests = 0;
    const providerRequests: Array<{ path: string; authorization: string | null; body: z.infer<typeof modelRequestSchema> }> = [];
    const approvals: Array<{ serverName: string; toolName: string; arguments: string }> = [];
    await withServer(request => agentMCPHandler(mcpState)(request), async mcpUrl => {
      await withServer(async request => {
        const body = modelRequestSchema.parse(await request.json());
        providerRequests.push({ path: new URL(request.url).pathname, authorization: request.headers.get('authorization'), body });
        modelRequests++;
        return modelRequests === 1 ? toolCallResponse() : chatReply('I found the quarterly plan.');
      }, async providerUrl => {
        const { text } = await runAgent({
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

        expect(text).toBe('I found the quarterly plan.');
        expect(approvals).toEqual([{ serverName: 'Test Tools', toolName: 'search', arguments: '{\n  "query": "quarterly plan"\n}' }]);
        expect(modelRequests).toBe(2);
        // The saved URL is used exactly, whatever path the SDK would build.
        expect(providerRequests.map(item => item.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
        expect(providerRequests.map(item => item.authorization)).toEqual(['Bearer provider-secret', 'Bearer provider-secret']);
        expect(providerRequests[0]?.body.model).toBe('test-model');
        expect(providerRequests[0]?.body.tools?.map(tool => tool.function.name)).toEqual(['mcp_1_0']);
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

  test('a denied tool never reaches the MCP server; the model is told and answers', async () => {
    const mcpState = newMCPFixtureState();
    const bodies: string[] = [];
    await withServer(request => agentMCPHandler(mcpState)(request), async mcpUrl => {
      await withServer(async request => {
        bodies.push(await request.text());
        return bodies.length === 1 ? toolCallResponse() : chatReply('I did not search.');
      }, async providerUrl => {
        const { text } = await runAgent({
          transcript: 'Search something.',
          settings: agentSettings(providerUrl, mcpUrl),
          signal: new AbortController().signal,
          fetch: globalThis.fetch,
          onStatus: () => {},
          approve: async () => false,
        });
        expect(text).toBe('I did not search.');
        expect(bodies[1]).toContain('User denied tool execution.');
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
          return step > 2 ? chatReply('Done.') : chatReply({ id: `call-${step}`, name: `mcp_${step}_0`, arguments: '{"query":"plan"}' });
        }, async providerUrl => {
          const base = agentSettings(providerUrl, allowedUrl);
          const settings = mobileSettingsSchema.parse({ ...base, mcpServers: [
            { ...base.mcpServers[0], toolPolicies: { search: 'alwaysAllow' } },
            { ...base.mcpServers[0], id: 'other', name: 'Other Tools', endpoint: `${askingUrl}/mcp` },
          ] });
          await runAgent({ transcript: 'Find a plan.', settings,
            signal: new AbortController().signal, fetch: globalThis.fetch, onStatus: () => {},
            approve: async approval => { approvals.push(approval.serverName); return false; },
          });
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
    const advertised: string[] = [];
    let approvals = 0;
    await withServer(agentMCPHandler(mcp), async mcpUrl => {
      let requests = 0;
      await withServer(async request => {
        const body = modelRequestSchema.parse(await request.json());
        advertised.push(...(body.tools ?? []).map(tool => tool.function.name));
        return ++requests === 1 ? toolCallResponse() : chatReply('That tool is unavailable.');
      }, async providerUrl => {
        const base = agentSettings(providerUrl, mcpUrl);
        const settings = mobileSettingsSchema.parse({ ...base, mcpServers: base.mcpServers.map(server => ({
          ...server, toolPolicies: { search: 'disabled' },
        })) });
        await runAgent({ transcript: 'Search.', settings,
          signal: new AbortController().signal, fetch: globalThis.fetch, onStatus: () => {},
          approve: async () => { approvals++; return true; },
        });
        expect(requests).toBe(2);
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

// Provider wire formats (Responses echo, cache markers, reasoning details) are shared with desktop and
// covered by app/src/agent/__tests__/fixtures/provider-contract.ts. These cover what iOS adds.
describe('conversation and limits', () => {
  test('a reply sends the earlier exchange before the new command', async () => {
    const bodies: z.infer<typeof modelRequestSchema>[] = [];
    await withServer(async request => {
      bodies.push(modelRequestSchema.parse(await request.json()));
      return chatReply(bodies.length === 1 ? 'Which city?' : 'It is sunny in Pune.');
    }, async url => {
      const settings = { ...agentSettings(url, url), mcpServers: [] };
      const run = (transcript: string, history?: Awaited<ReturnType<typeof runAgent>>['messages']) => runAgent({ transcript, settings, history,
        signal: new AbortController().signal, fetch: globalThis.fetch, onStatus: () => {}, approve: async () => true });
      const first = await run('What is the weather?');
      expect((await run('Pune.', first.messages)).text).toBe('It is sunny in Pune.');
      expect(bodies[1]?.messages.map(message => [message.role, message.content])).toEqual([
        ['system', expect.stringContaining('<identity>')],
        ['user', expect.stringMatching(/\n\nWhat is the weather\?$/)],
        ['assistant', 'Which city?'],
        ['user', expect.stringMatching(/\n\nPune\.$/)],
      ]);
    });
  });

  test('an endpoint that never sends response headers times out instead of hanging', async () => {
    jest.useFakeTimers();
    try {
      const sent = Promise.withResolvers<void>();
      const fetch = Object.assign((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        sent.resolve();
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }), { preconnect: globalThis.fetch.preconnect });
      const failure = errorFrom(runAgent({ transcript: 'Explain.', signal: new AbortController().signal, fetch, onStatus: () => {}, approve: async () => true,
        settings: { ...agentSettings('http://127.0.0.1:9', 'http://127.0.0.1:9'), mcpServers: [] } }));
      await sent.promise;
      jest.advanceTimersByTime(180_000);
      expect((await failure).message).toBe('Agent model endpoint: The endpoint stopped responding. The request timed out.');
    } finally { jest.useRealTimers(); }
  });

  test('an answer cut off at the output limit is reported instead of shown as complete', async () => {
    await withServer(() => chatReply('Half an ans', 'length'), async url => {
      const failure = await errorFrom(runAgent({
        transcript: 'Explain.', signal: new AbortController().signal, fetch: globalThis.fetch, onStatus: () => {}, approve: async () => true,
        settings: { ...agentSettings(url, url), mcpServers: [] },
      }));
      expect(failure.message).toBe('The agent reached its output limit. Try a shorter command.');
    });
  });
});
