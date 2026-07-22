import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { AisdkMcpClientFactory } from '../mcp-registry-adapters';
import type { McpOAuthProviderResolver } from '../mcp-registry-adapters';
import type { McpServerConfig } from '../../types/ipc';

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeServer));
});

describe('HTTP MCP redirect policy', () => {
  it('rejects redirects by default and follows them only after explicit opt-in', async () => {
    let destinationRequests = 0;
    const destination = await listen(createServer(async (request, response) => {
      destinationRequests += 1;
      await handleMcpRequest(request, response);
    }));
    const destinationUrl = serverUrl(destination);
    const redirecting = await listen(createServer((_request, response) => {
      response.writeHead(307, { Location: `${destinationUrl}/mcp` }).end();
    }));
    const redirectingUrl = `${serverUrl(redirecting)}/mcp`;
    const oauthProviderResolver: McpOAuthProviderResolver = { resolve: () => undefined };
    const bunFetch = (Bun as unknown as { fetch: typeof globalThis.fetch }).fetch;
    const factory = new AisdkMcpClientFactory(oauthProviderResolver, undefined, bunFetch);

    await expect(factory.connect(makeServer(redirectingUrl, 'error'))).rejects.toThrow();
    expect(destinationRequests).toBe(0);

    const client = await factory.connect(makeServer(redirectingUrl, 'follow'));
    expect(await client.tools()).toEqual({});
    expect(destinationRequests).toBeGreaterThan(0);
    await client.close();
  });
});

function makeServer(url: string, redirect: 'error' | 'follow'): McpServerConfig {
  return {
    id: `redirect-${redirect}`,
    displayName: `Redirect ${redirect}`,
    enabled: true,
    transport: { type: 'http', url, redirect },
    discoveredTools: [],
    toolPolicies: {},
  };
}

async function handleMcpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }

  const body = await readBody(request);
  const message = JSON.parse(body) as { id?: string | number; method?: string };
  if (message.method === 'initialize') {
    sendJson(response, {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'redirect-test', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    sendJson(response, { jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    return;
  }

  response.writeHead(202).end();
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  return body;
}

function listen(server: Server): Promise<Server> {
  openServers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serverUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address.');
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
