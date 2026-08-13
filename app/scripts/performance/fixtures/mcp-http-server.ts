import { createServer } from 'http';
import { handleBenchmarkMcpRequest, type JsonRpcRequest } from './benchmark-mcp';

export async function startMcpHttpFixture({ port }: { port: number }): Promise<{
  port: number;
  stop: (force?: boolean) => void;
}> {
  const server = createServer((request, response) => {
    if (request.url !== '/mcp' || request.method !== 'POST') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Not found');
      return;
    }

    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRpcRequest;
        const result = handleBenchmarkMcpRequest(payload);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(result ? JSON.stringify(result) : '');
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Benchmark MCP HTTP server did not bind a TCP port');
  }
  return {
    port: address.port,
    stop(force = false) {
      if (force) server.closeAllConnections();
      server.close();
    },
  };
}

if (import.meta.main) {
  const requestedPort = Number(process.env.SHUDDHALEKHAN_BENCHMARK_MCP_PORT ?? '0');
  const server = await startMcpHttpFixture({ port: requestedPort });
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}/mcp`, pid: process.pid }));
}
