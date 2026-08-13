import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { request } from 'http';
import { join } from 'path';

function postJson(port: number, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const client = request({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    client.on('error', reject);
    client.end(JSON.stringify(body));
  });
}

function postRaw(port: number, path: string, body: unknown): Promise<{
  status: number;
  contentType: string;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const client = request({
      hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        contentType: String(response.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    client.on('error', reject);
    client.end(JSON.stringify(body));
  });
}

describe('benchmark MCP fixtures', () => {
  it('publishes executable transport definitions in the scenario manifest', () => {
    const manifest = JSON.parse(readFileSync(
      join(import.meta.dir, '..', 'performance', 'fixtures', 'manifest.json'),
      'utf8',
    ));
    const transports = manifest.fixtures.mcp['echo-tool-v1'].transports;

    expect(transports.stdio).toMatchObject({ type: 'stdio', command: 'bun' });
    expect(transports.http).toMatchObject({ type: 'http', endpoint: 'http://127.0.0.1:43176/mcp' });
    for (const transport of Object.values(transports) as Array<{ entrypoint: string }>) {
      expect(existsSync(join(import.meta.dir, '..', 'performance', 'fixtures', transport.entrypoint))).toBe(true);
    }
  });

  it('serves a deterministic echo tool over stdio MCP', async () => {
    const server = Bun.spawn([
      process.execPath,
      'run',
      join(import.meta.dir, '..', 'performance', 'fixtures', 'mcp-stdio-server.ts'),
    ], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });

    server.stdin.write([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { message: 'benchmark' } } }),
      '',
    ].join('\n'));
    server.stdin.end();

    const responses = (await new Response(server.stdout).text())
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(await server.exited).toBe(0);
    expect(responses).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'shuddhalekhan-benchmark-echo', version: '1.0.0' },
        },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [{
            name: 'echo',
            description: 'Return the provided benchmark message.',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message'],
              additionalProperties: false,
            },
          }],
        },
      },
      {
        jsonrpc: '2.0',
        id: 3,
        result: { content: [{ type: 'text', text: 'benchmark' }] },
      },
    ]);
  });

  it('serves the same deterministic echo tool over HTTP MCP', async () => {
    const { startMcpHttpFixture } = await import('../performance/fixtures/mcp-http-server');
    const server = await startMcpHttpFixture({ port: 0 });

    try {
      const response = await postJson(server.port, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'echo', arguments: { message: 'benchmark' } },
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'benchmark' }] },
      });
    } finally {
      server.stop(true);
    }
  });

  it('serves deterministic transcription and OpenAI-compatible streaming responses', async () => {
    const { startBenchmarkProviderFixture } = await import('../performance/fixtures/benchmark-provider-server');
    const server = await startBenchmarkProviderFixture({ port: 0 });

    try {
      const transcription = await postRaw(server.port, '/inference', { fixture: true });
      expect(JSON.parse(transcription.body)).toEqual({ text: 'benchmark fixture transcript' });

      const completion = await postRaw(server.port, '/v1/chat/completions', {
        model: 'benchmark-fixture-v1', messages: [{ role: 'user', content: 'hello' }], stream: true,
      });
      expect(completion.contentType).toContain('text/event-stream');
      expect(completion.body).toContain('benchmark complete');
      expect(completion.body).toContain('data: [DONE]');
    } finally {
      server.stop(true);
    }
  });
});
