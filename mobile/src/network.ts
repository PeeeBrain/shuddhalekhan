import { z } from 'zod';
import { validateEndpoint } from './settings';

export type Fetch = typeof globalThis.fetch;

/** One request budget includes reading the body, so a stalled SSE stream can be cancelled. */
export async function request<T>({ fetch, endpoint, allowHTTP, signal, init, read, timeoutMs = 90_000 }: {
  fetch: Fetch;
  endpoint: string;
  allowHTTP: boolean;
  signal: AbortSignal;
  init: RequestInit;
  read: (response: Response, signal: AbortSignal) => Promise<T>;
  timeoutMs?: number;
}): Promise<T> {
  validateEndpoint(endpoint, allowHTTP);
  signal.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let response: Response | undefined;
  try {
    response = await fetch(endpoint, { ...init, signal: controller.signal, redirect: 'error', credentials: 'omit' });
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? ' Check the saved credentials.'
        : response.status === 429 ? ' Rate limited. Try again later.'
        : response.status === 404 ? ' Check the full endpoint URL.' : '';
      // Provider bodies can contain keys, transcripts, or tool arguments. Never display them as errors.
      throw new Error(`Request failed (HTTP ${response.status}).${hint}`);
    }
    return await read(response, controller.signal);
  } catch (error) {
    signal.throwIfAborted();
    // Strip causes from UI errors; native fetch errors may contain credential-bearing URLs.
    // oxlint-disable-next-line preserve-caught-error
    if (timedOut) throw new Error('The endpoint stopped responding. The request timed out.');
    // oxlint-disable-next-line preserve-caught-error
    // No response means a transport failure. expo/fetch reports these as plain `Error('fetch failed: …')`, not TypeError.
    if (!response || error instanceof TypeError) throw new Error('Could not reach the endpoint. Check its URL, TLS certificate, network access, whether it redirects, and that the server listens on this address, not only localhost.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    await response?.body?.cancel().catch(() => {});
  }
}

export async function readJSON(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('The endpoint returned an empty response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2_000_000) throw new Error('The endpoint response is too large.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try { return JSON.parse(text); } catch { throw new Error('The endpoint returned invalid JSON.'); }
}

export function parseResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new Error('The endpoint returned an unsupported response.');
  return result.data;
}

export function bearerHeaders(key: string): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}
