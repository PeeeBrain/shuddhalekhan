import { expect, test } from 'bun:test';
import { readJSON, request } from '../network';

test('request deadline includes a stalled response body, not just arrival of HTTP headers', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }));
  } });
  try {
    await expect(request({ fetch, endpoint: `http://127.0.0.1:${server.port}`, allowHTTP: true,
      signal: new AbortController().signal, timeoutMs: 50, init: {}, read: readJSON,
    })).rejects.toThrow('timed out');
  } finally { await server.stop(true); }
});

test('oversized JSON streams are cancelled before the complete body is buffered', async () => {
  let cancelled = false;
  let generated = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { generated++; controller.enqueue(new Uint8Array(1_000_000)); },
    cancel() { cancelled = true; },
  }));
  await expect(readJSON(response)).rejects.toThrow('too large');
  expect(cancelled).toBe(true);
  expect(generated).toBeLessThan(6);
});

test('native fetch failures (expo/fetch FetchError, not TypeError) get network guidance without leaking the URL', async () => {
  // expo/fetch rejects with `Error('fetch failed: <NSURLError localizedDescription>')`, not TypeError.
  const nativeFetch = (async () => { throw new Error('fetch failed: The request timed out. https://key@100.64.0.1/v1'); }) as unknown as typeof fetch;
  const error = await request({ fetch: nativeFetch, endpoint: 'http://100.64.0.1:1234/v1/chat/completions', allowHTTP: true,
    signal: new AbortController().signal, init: {}, read: readJSON }).then(() => new Error("resolved"), (caught: Error) => caught);
  expect(error.message).toStartWith('Could not reach the endpoint.');
  expect(error.message).not.toContain('100.64');
});
