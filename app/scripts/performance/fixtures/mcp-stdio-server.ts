import { createInterface } from 'readline';
import { handleBenchmarkMcpRequest, type JsonRpcRequest } from './benchmark-mcp';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    const response = handleBenchmarkMcpRequest(JSON.parse(line) as JsonRpcRequest);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stderr.write(`Invalid benchmark MCP request: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
