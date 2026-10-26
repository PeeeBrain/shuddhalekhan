import { describe, expect, test } from 'bun:test';
import { transcribe } from '../transcription';
import { defaultSettings, type MobileSettings } from '../settings';
import { recordingLimitSeconds } from '../providers';

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

// Sarvam and Google are fixed HTTPS services; route their hosts to the local server and keep the path.
function viaLocal(base: string, hosts: string[] = []): typeof fetch {
  return Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    hosts.push(new URL(String(input)).host);
    return globalThis.fetch(String(input).replace(/^https:\/\/[^/]+/, base), init);
  }, { preconnect: globalThis.fetch.preconnect });
}

const audio = () => new Blob(['audio bytes'], { type: 'audio/wav' });

describe('provider request contracts', () => {
  test('Sarvam accepts audio when automatic stop arrives over one timer tick late', async () => {
    let uploads = 0;
    await withServer(async request => {
      const form = await request.formData();
      expect(form.get('file')).toBeInstanceOf(File);
      uploads++;
      return Response.json({ transcript: 'kept dictation' });
    }, async url => {
      const config = settings('', { transcriptionProvider: 'sarvam', transcriptionModel: 'saaras:v4' });
      const delayedStopSeconds = recordingLimitSeconds(config) + 1.25;
      const recording = new Blob([new Uint8Array(44 + delayedStopSeconds * 32_000)], { type: 'audio/wav' });
      await expect(transcribe({ audio: recording, settings: config, signal: new AbortController().signal,
        fetch: viaLocal(url) })).resolves.toBe('kept dictation');
      expect(uploads).toBe(1);
    });
  });

  test('Azure fast transcription sends the regional locale and phrase list with its subscription key', async () => {
    let received: { path: string; key: string | null; definition: unknown; audio: boolean } | null = null;
    await withServer(async request => {
      const form = await request.formData();
      const url = new URL(request.url);
      received = { path: `${url.pathname}${url.search}`, key: request.headers.get('ocp-apim-subscription-key'),
        definition: JSON.parse(String(form.get('definition'))), audio: form.get('audio') instanceof File };
      return Response.json({ combinedPhrases: [{ text: 'namaste team' }] });
    }, async url => {
      const text = await transcribe({ audio: audio(), signal: new AbortController().signal, fetch: globalThis.fetch,
        settings: settings(url, { transcriptionProvider: 'azure-speech', language: 'en-in', dictionary: 'Shuddhalekhan, Partha' }) });
      expect(text).toBe('namaste team');
      expect(received).toEqual({ path: '/speechtotext/transcriptions:transcribe?api-version=2025-10-15', key: 'transcription-secret',
        definition: { locales: ['en-IN'], phraseList: { phrases: ['Shuddhalekhan', 'Partha'] } }, audio: true });
    });
  });

  test('Sarvam receives its language code and v4 key terms, never a bearer token', async () => {
    let received: Record<string, string | null> | null = null;
    await withServer(async request => {
      const form = await request.formData();
      received = { path: new URL(request.url).pathname, key: request.headers.get('api-subscription-key'), auth: request.headers.get('authorization'),
        model: String(form.get('model')), mode: String(form.get('mode')), language: String(form.get('language_code')), keyterms: String(form.get('keyterms')) };
      return Response.json({ transcript: 'नमस्ते' });
    }, async url => {
      const hosts: string[] = [];
      const text = await transcribe({ audio: audio(), signal: new AbortController().signal, fetch: viaLocal(url, hosts),
        settings: settings('', { transcriptionProvider: 'sarvam', transcriptionModel: 'saaras:v4', language: 'hi', dictionary: 'Pune' }) });
      expect(text).toBe('नमस्ते');
      expect(hosts).toEqual(['api.sarvam.ai']);
      expect(received).toEqual({ path: '/speech-to-text', key: 'transcription-secret', auth: null,
        model: 'saaras:v4', mode: 'transcribe', language: 'hi-IN', keyterms: '["Pune"]' });
    });
  });

  test('Google signs a token request for the fixed audience, then recognizes on the regional host with the locale', async () => {
    const requests: { path: string; auth: string | null; body: string }[] = [];
    const signed: string[] = [];
    await withServer(async request => {
      const url = new URL(request.url);
      requests.push({ path: url.pathname, auth: request.headers.get('authorization'), body: await request.text() });
      return url.pathname === '/token' ? Response.json({ access_token: 'google-token' })
        : Response.json({ results: [{ alternatives: [{ transcript: 'hello' }] }, { alternatives: [{ transcript: 'there' }] }] });
    }, async url => {
      const hosts: string[] = [];
      // A pasted token_uri must never receive the signed assertion.
      const serviceAccount = JSON.stringify({ type: 'service_account', client_email: 'dictation@project.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n', token_uri: 'https://attacker.example/token' });
      const text = await transcribe({ audio: audio(), signal: new AbortController().signal, fetch: viaLocal(url, hosts),
        signGoogleJwt: async (_key, input) => { signed.push(input); return 'signature'; },
        settings: settings('', { transcriptionProvider: 'google-cloud-speech-v2', transcriptionModel: 'chirp_3', googleProject: 'my-project',
          googleLocation: 'us', googleServiceAccount: serviceAccount, language: 'en-IN', dictionary: 'Shuddhalekhan' }) });
      expect(text).toBe('hello there');
      expect(hosts).toEqual(['oauth2.googleapis.com', 'us-speech.googleapis.com']);
      const claims: unknown = JSON.parse(Buffer.from(signed[0]!.split('.')[1]!, 'base64url').toString());
      expect(claims).toMatchObject({ iss: 'dictation@project.iam.gserviceaccount.com', aud: 'https://oauth2.googleapis.com/token' });
      expect(new URLSearchParams(requests[0]!.body).get('assertion')).toBe(`${signed[0]}.signature`);
      expect(requests[1]).toMatchObject({ path: '/v2/projects/my-project/locations/us/recognizers/_:recognize', auth: 'Bearer google-token' });
      expect(JSON.parse(requests[1]!.body)).toEqual({ content: Buffer.from('audio bytes').toString('base64'), config: {
        autoDecodingConfig: {}, languageCodes: ['en-IN'], model: 'chirp_3',
        adaptation: { phraseSets: [{ inlinePhraseSet: { phrases: [{ value: 'Shuddhalekhan' }] } }] } } });
    });
  });

  test('NVIDIA NIM gets a Riva locale and a custom secret header, and the dictionary only when enabled', async () => {
    const received: Record<string, unknown>[] = [];
    await withServer(async request => {
      const form = await request.formData();
      received.push({ language: form.get('language'), prompt: form.get('prompt'),
        header: request.headers.get('x-nim-key'), auth: request.headers.get('authorization') });
      return Response.json({ text: 'ok' });
    }, async url => {
      const nim = settings(`${url}/v1/audio/transcriptions`, { transcriptionProvider: 'nvidia-speech-nim', transcriptionAuth: 'header', transcriptionHeaderName: 'X-NIM-Key', language: 'es' });
      await transcribe({ audio: audio(), signal: new AbortController().signal, fetch: globalThis.fetch, settings: nim });
      await transcribe({ audio: audio(), signal: new AbortController().signal, fetch: globalThis.fetch, settings: { ...nim, language: 'en', nimDictionary: true } });
      expect(received).toEqual([
        { language: 'es-US', prompt: null, header: 'transcription-secret', auth: null },
        { language: 'en-US', prompt: 'Shuddhalekhan names', header: 'transcription-secret', auth: null },
      ]);
    });
  });

  test('Google accepts a late automatic stop but rejects audio beyond its synchronous limit before authentication', async () => {
    let uploads = 0;
    await withServer(async request => {
      if (new URL(request.url).pathname === '/token') return Response.json({ access_token: 'google-token' });
      await request.json();
      uploads++;
      return Response.json({ results: [{ alternatives: [{ transcript: 'kept dictation' }] }] });
    }, async url => {
      const config = settings('', { transcriptionProvider: 'google-cloud-speech-v2', googleProject: 'my-project',
        googleServiceAccount: JSON.stringify({ type: 'service_account', client_email: 'dictation@project.iam.gserviceaccount.com',
          private_key: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n' }) });
      let signatures = 0;
      const invoke = (seconds: number) => transcribe({ settings: config, signal: new AbortController().signal, fetch: viaLocal(url),
        audio: new Blob([new Uint8Array(44 + seconds * 32_000)], { type: 'audio/wav' }),
        signGoogleJwt: async () => { signatures++; return 'signature'; } });
      await expect(invoke(recordingLimitSeconds(config) + 2)).resolves.toBe('kept dictation');
      await expect(invoke(60)).rejects.toThrow('Keep Google Cloud Speech recordings under 55 seconds.');
      expect(uploads).toBe(1);
      expect(signatures).toBe(1);
    });
  });

  test('whisper.cpp gets deterministic decoding and the base language, with no model or credential', async () => {
    let received: Record<string, unknown> | null = null;
    await withServer(async request => {
      const form = await request.formData();
      received = { model: form.get('model'), language: form.get('language'), temperature: form.get('temperature'), auth: request.headers.get('authorization') };
      return Response.json({ text: 'ok' });
    }, async url => {
      await transcribe({ audio: audio(), signal: new AbortController().signal, fetch: globalThis.fetch,
        settings: settings(`${url}/inference`, { transcriptionProvider: 'local-whisper-cpp', language: 'en-IN' }) });
      expect(received).toEqual({ model: null, language: 'en', temperature: '0', auth: null });
    });
  });

  test('hosted providers fail before any request when their key is missing', async () => {
    let requests = 0;
    await withServer(() => { requests++; return Response.json({ text: 'ok' }); }, async url => {
      const failure = await errorFrom(transcribe({ audio: audio(), signal: new AbortController().signal, fetch: globalThis.fetch,
        settings: settings(url, { transcriptionProvider: 'azure-speech', transcriptionKey: '' }) }));
      expect(failure.message).toBe('Enter the transcription provider API key in Settings.');
      expect(requests).toBe(0);
    });
  });
});
