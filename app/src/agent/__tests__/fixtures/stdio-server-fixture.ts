import { createInterface } from 'readline';

const ignoreEof = process.argv.includes('--ignore-stdin-eof');
const mcp = process.argv.includes('--mcp');
const hangToolCalls = process.argv.includes('--hang-tool-calls');

if (!mcp) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, result: { ready: true, pid: process.pid } })}\n`);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line) as { id?: unknown; method?: string; params?: { name?: string } };
    if (hangToolCalls && message.method === 'tools/call') return;
    if (mcp) {
      if (message.id === undefined) return;
      let result;
      switch (message.method) {
        case 'initialize':
          result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } };
          break;
        case 'tools/list':
          result = { tools: [{ name: 'check_environment', inputSchema: { type: 'object' } }] };
          break;
        case 'tools/call': {
          if (message.params?.name !== 'check_environment') {
            process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool' } })}\n`);
            return;
          }
          const token = process.env.FIXTURE_TOKEN;
          process.stdout.write(`not-json ${token ?? ''}\n`);
          result = { content: [], structuredContent: {
            declared: token === 's3cret-value',
            path: process.env.PATH,
            undeclared: process.env.FIXTURE_UNDECLARED !== undefined,
          } };
          break;
        }
        default:
          process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } })}\n`);
          return;
      }
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      return;
    }
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echoed: message.method } })}\n`
    );
  } catch {
    process.stdout.write('not-json-at-all\n');
  }
});

if (!ignoreEof) {
  input.on('close', () => process.exit(0));
}

setInterval(() => undefined, 60_000);
