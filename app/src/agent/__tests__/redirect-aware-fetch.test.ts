import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'http';
import { createRedirectAwareFetch } from '../oauth-provider';

const bunFetch = (Bun as unknown as { fetch: typeof globalThis.fetch }).fetch;
const NativeAbortController = (
  globalThis as typeof globalThis & { __nativeAbortController: typeof AbortController }
).__nativeAbortController;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address.');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('redirect-aware fetch AbortSignal compatibility', () => {
  it('accepts an ordinary AbortSignal and completes the request', async () => {
    const fetchWithRedirectPolicy = createRedirectAwareFetch(bunFetch, 'error');
    const controller = new NativeAbortController();

    const response = await fetchWithRedirectPolicy(origin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('rejects a pre-aborted AbortSignal', async () => {
    const fetchWithRedirectPolicy = createRedirectAwareFetch(bunFetch, 'error');
    const controller = new NativeAbortController();
    controller.abort();

    await expect(fetchWithRedirectPolicy(origin, { signal: controller.signal })).rejects.toThrow();
  });
});
