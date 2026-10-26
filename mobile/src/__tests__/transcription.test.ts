import { describe, expect, test } from 'bun:test';
import { transcribe } from '../transcription';
import { defaultSettings, type MobileSettings } from '../settings';

async function withServer<T>(
  handler: (request: Request) => Response | Promise<Response>,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  try {
    return await run(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop(true);
  }
}

function settings(endpoint: string, overrides: Partial<MobileSettings> = {}): MobileSettings {
  return {
    ...defaultSettings,
    transcriptionEndpoint: endpoint,
    transcriptionModel: 'whisper-test',
    transcriptionKey: 'transcription-secret',
    language: 'en',
    dictionary: '  Shuddhalekhan names  ',
    allowInsecureHTTP: true,
    ...overrides,
  };
}

function errorFrom<T>(promise: Promise<T>): Promise<Error> {
  return promise.then(
    () => { throw new Error('Expected the request to fail.'); },
    error => {
      if (error instanceof Error) return error;
      throw new Error('The request failed without an Error object.');
    },
  );
}

describe('transcription HTTP contract', () => {
  test('uploads audio and transcription options as multipart fields', async () => {
    let received: {
      method: string;
      authorization: string | null;
      contentType: string | null;
      model: FormDataEntryValue | null;
      responseFormat: FormDataEntryValue | null;
      language: FormDataEntryValue | null;
      prompt: FormDataEntryValue | null;
      file: { name: string; type: string; content: string } | null;
    } | null = null;
    await withServer(async request => {
      const form = await request.formData();
      const file = form.get('file');
      received = {
        method: request.method,
        authorization: request.headers.get('authorization'),
        contentType: request.headers.get('content-type'),
        model: form.get('model'),
        responseFormat: form.get('response_format'),
        language: form.get('language'),
        prompt: form.get('prompt'),
        file: file instanceof File ? { name: file.name, type: file.type, content: await file.text() } : null,
      };
      return Response.json({ text: '  recognized words  ' });
    }, async url => {
      const text = await transcribe({
        audio: new Blob(['audio bytes'], { type: 'audio/wav' }),
        settings: settings(`${url}/inference`),
        signal: new AbortController().signal,
        fetch: globalThis.fetch,
      });
      expect(text).toBe('recognized words');
      expect(received?.method).toBe('POST');
      expect(received?.authorization).toBe('Bearer transcription-secret');
      expect(received?.contentType).toContain('multipart/form-data; boundary=');
      expect(received?.model).toBe('whisper-test');
      expect(received?.responseFormat).toBe('json');
      expect(received?.language).toBe('en');
      expect(received?.prompt).toBe('Shuddhalekhan names');
      expect(received?.file).toMatchObject({ name: 'recording.wav', content: 'audio bytes' });
      expect(['audio/wav', 'audio/x-wav']).toContain(received?.file?.type ?? '');
    });
  });

  test('does not expose malformed or failing endpoint response bodies', async () => {
    let requests = 0;
    await withServer(() => {
      requests++;
      return requests === 1
        ? new Response('{"text":', { headers: { 'Content-Type': 'application/json' } })
        : new Response('provider leaked transcription-secret and private transcript', { status: 503 });
    }, async url => {
      const invoke = () => transcribe({
        audio: new Blob(['audio bytes'], { type: 'audio/wav' }),
        settings: settings(`${url}/inference`),
        signal: new AbortController().signal,
        fetch: globalThis.fetch,
      });
      const malformed = await errorFrom(invoke());
      expect(malformed.message).toBe('The endpoint returned invalid JSON.');
      expect(malformed.message).not.toContain('transcription-secret');
      expect(malformed.message).not.toContain('private transcript');

      const failed = await errorFrom(invoke());
      expect(failed.message).toBe('Request failed (HTTP 503).');
      expect(failed.message).not.toContain('transcription-secret');
      expect(failed.message).not.toContain('private transcript');
    });
  });

  test('rejects insecure HTTP unless the saved setting explicitly allows it', async () => {
    let requests = 0;
    await withServer(() => {
      requests++;
      return Response.json({ text: 'done' });
    }, async url => {
      const input = {
        audio: new Blob(['audio bytes'], { type: 'audio/wav' }),
        settings: settings(`${url}/inference`, { allowInsecureHTTP: false }),
        signal: new AbortController().signal,
        fetch: globalThis.fetch,
      };
      const failure = await errorFrom(transcribe(input));
      expect(failure.message).toBe('Use HTTPS, or explicitly allow unencrypted HTTP in Settings.');
      expect(requests).toBe(0);

      await expect(transcribe({ ...input, settings: { ...input.settings, allowInsecureHTTP: true } })).resolves.toBe('done');
      expect(requests).toBe(1);
    });
  });

  test('does not forward bearer credentials across an HTTP redirect', async () => {
    const redirectAuthorizations: Array<string | null> = [];
    await withServer(request => {
      redirectAuthorizations.push(request.headers.get('authorization'));
      return new Response(null, { status: 204 });
    }, async targetUrl => {
      let sourceHits = 0;
      let sourceAuthorization: string | null = null;
      await withServer(request => {
        sourceHits++;
        sourceAuthorization = request.headers.get('authorization');
        return new Response(null, { status: 302, headers: { Location: `${targetUrl}/capture` } });
      }, async sourceUrl => {
        const failure = await errorFrom(transcribe({
          audio: new Blob(['audio bytes'], { type: 'audio/wav' }),
          settings: settings(`${sourceUrl}/inference`),
          signal: new AbortController().signal,
          fetch: globalThis.fetch,
        }));
        expect(failure.message).toStartWith('Could not reach the endpoint.');
        expect(failure.message).not.toContain('transcription-secret');
        expect(sourceHits).toBe(1);
        expect(sourceAuthorization).toBe('Bearer transcription-secret');
        expect(redirectAuthorizations).toEqual([]);
      });
    });
  });
});
