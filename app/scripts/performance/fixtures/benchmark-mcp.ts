export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

export const benchmarkEchoTool = {
  name: 'echo',
  description: 'Return the provided benchmark message.',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false,
  },
};

export function handleBenchmarkMcpRequest(request: JsonRpcRequest): Record<string, unknown> | null {
  if (request.id === undefined) return null;

  const envelope = { jsonrpc: '2.0', id: request.id };
  switch (request.method) {
    case 'initialize':
      return {
        ...envelope,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'shuddhalekhan-benchmark-echo', version: '1.0.0' },
        },
      };
    case 'tools/list':
      return { ...envelope, result: { tools: [benchmarkEchoTool] } };
    case 'tools/call': {
      const args = request.params?.arguments as { message?: unknown } | undefined;
      const text = typeof args?.message === 'string' ? args.message : '';
      return { ...envelope, result: { content: [{ type: 'text', text }] } };
    }
    default:
      return {
        ...envelope,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      };
  }
}
