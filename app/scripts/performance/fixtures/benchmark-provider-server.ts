import { createServer, type ServerResponse } from 'http';

function writeSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function completionChunk(
  delta: Record<string, unknown>,
  finishReason: string | null,
): Record<string, unknown> {
  return {
    id: 'chatcmpl-benchmark-fixture',
    object: 'chat.completion.chunk',
    created: 1_786_560_000,
    model: 'benchmark-fixture-v1',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export async function startBenchmarkProviderFixture(options: { port: number }): Promise<{
  baseUrl: string;
  port: number;
  stop: (force?: boolean) => void;
}> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      if (request.url === '/inference') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ text: 'benchmark fixture transcript' }));
        return;
      }
      if (request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }

      let body: {
        tools?: Array<{ function?: { name?: string } }>;
        messages?: Array<{ role?: string }>;
      };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400).end();
        return;
      }

      const toolName = body.tools?.[0]?.function?.name;
      const hasToolResult = body.messages?.some((message) => message.role === 'tool');
      if (toolName && !hasToolResult) {
        writeSse(response, [
          completionChunk({
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'benchmark-tool-call-1',
              type: 'function',
              function: { name: toolName, arguments: '{"message":"benchmark"}' },
            }],
          }, null),
          completionChunk({}, 'tool_calls'),
        ]);
        return;
      }

      writeSse(response, [
        completionChunk({ role: 'assistant', content: 'benchmark complete' }, null),
        completionChunk({}, 'stop'),
      ]);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Benchmark provider fixture did not bind a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    stop(force = false) {
      if (force) server.closeAllConnections();
      server.close();
    },
  };
}

if (import.meta.main) {
  const requestedPort = Number(process.env.SHUDDHALEKHAN_BENCHMARK_PROVIDER_PORT ?? '43175');
  const server = await startBenchmarkProviderFixture({ port: requestedPort });
  console.log(JSON.stringify({ baseUrl: server.baseUrl, pid: process.pid }));
}
