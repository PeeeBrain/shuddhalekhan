import { describe, expect, it, mock } from 'bun:test';
import type NodeWebSocket from 'ws';
import {
  checkWhisperLiveKitReadiness,
  WHISPER_LIVE_KIT_CAPABILITIES,
  createWhisperLiveKitStreamingSession,
  createWhisperLiveKitTranscriber,
  deriveWhisperLiveKitEndpoints,
  validateWhisperLiveKitSettings,
} from '../whisper-live-kit';

class FakeSocket {
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();
  readonly sent: Array<string | Uint8Array> = [];
  closed = false;

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }

  close(): void {
    this.closed = true;
  }

  send(data: string | Uint8Array, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }

  emit(type: string, event: Event = new Event(type)): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('WhisperLiveKit endpoint contract', () => {
  it('derives batch, health, and full-mode WebSocket endpoints from a loopback base URL', () => {
    expect(deriveWhisperLiveKitEndpoints('http://127.0.0.1:8000/')).toEqual({
      baseUrl: 'http://127.0.0.1:8000',
      transcription: 'http://127.0.0.1:8000/v1/audio/transcriptions',
      health: 'http://127.0.0.1:8000/health',
      websocket: 'ws://127.0.0.1:8000/asr?mode=full',
    });
  });

  it('allows loopback HTTP and remote HTTPS but rejects unsafe endpoint configurations', () => {
    expect(validateWhisperLiveKitSettings({
      baseUrl: 'http://localhost:8000',
      auth: 'none',
    })).toEqual([]);
    expect(validateWhisperLiveKitSettings({
      baseUrl: 'https://speech.example.com/wlk',
      auth: 'bearer',
    })).toEqual([]);
    expect(validateWhisperLiveKitSettings({
      baseUrl: 'http://speech.example.com:8000',
      auth: 'none',
    })).toEqual(['Remote WhisperLiveKit endpoints must use HTTPS.']);
    expect(validateWhisperLiveKitSettings({
      baseUrl: 'https://user:secret@speech.example.com',
      auth: 'none',
    })).toEqual(['WhisperLiveKit endpoint URLs cannot contain credentials.']);
  });

  it('transcribes through the OpenAI-compatible batch endpoint with optional bearer auth', async () => {
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: async () => ({ text: '  Quick brown fox.  ' }),
    } as Response));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const transcriber = createWhisperLiveKitTranscriber(
      { baseUrl: 'http://127.0.0.1:8000', auth: 'bearer' },
      'secret-token',
    );

    await expect(transcriber.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      recognition: {
        language: 'auto',
        task: 'transcribe',
        dictionary: [],
        removeFillerWords: false,
      },
    })).resolves.toBe('Quick brown fox.');

    expect(transcriber.capabilities).toEqual(WHISPER_LIVE_KIT_CAPABILITIES);
    expect(transcriber.transportCapabilities).toEqual({ batch: true, streaming: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer secret-token' },
      }),
    );
  });

  it('declares no provider-imposed duration limit, rejects translation, and ignores dictionary hints', async () => {
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: async () => ({ text: 'Shuddhalekhan' }),
    } as Response));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const transcriber = createWhisperLiveKitTranscriber(
      { baseUrl: 'http://127.0.0.1:8000', auth: 'none' },
      null,
    );

    expect(transcriber.capabilities.maxDurationSeconds).toBeNull();
    await expect(transcriber.transcribe({
      audio: new Uint8Array([1]),
      recognition: { language: 'en', task: 'translate', dictionary: [], removeFillerWords: false },
    })).rejects.toMatchObject({
      category: 'model',
      message: 'WhisperLiveKit batch transcription does not support translation.',
    });
    await expect(transcriber.transcribe({
      audio: new Uint8Array([1]),
      recognition: { language: 'en', task: 'transcribe', dictionary: ['Shuddhalekhan'], removeFillerWords: false },
    })).resolves.toBe('Shuddhalekhan');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((request.body as FormData).has('prompt')).toBe(false);
  });

  it('sanitizes network, HTTP, and malformed batch failures', async () => {
    const fetchMock = mock(() => Promise.reject(new Error('token=super-secret')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const transcriber = createWhisperLiveKitTranscriber(
      { baseUrl: 'http://127.0.0.1:8000', auth: 'none' },
      null,
    );
    const request = {
      audio: new Uint8Array([1]),
      recognition: { language: 'auto', task: 'transcribe' as const, dictionary: [], removeFillerWords: false },
    };

    await expect(transcriber.transcribe(request)).rejects.toMatchObject({
      category: 'network',
      message: 'Could not reach WhisperLiveKit. Check the endpoint and network connection.',
    });
    fetchMock.mockImplementationOnce(() => Promise.resolve({
      ok: false,
      status: 401,
      text: async () => 'token=super-secret',
    } as Response));
    await expect(transcriber.transcribe(request)).rejects.toMatchObject({
      category: 'authentication',
      message: 'WhisperLiveKit rejected authentication.',
    });
    fetchMock.mockImplementationOnce(() => Promise.resolve({
      ok: true,
      json: async () => ({ secret: 'super-secret' }),
    } as Response));
    await expect(transcriber.transcribe(request)).rejects.toMatchObject({
      category: 'malformed-response',
      message: 'WhisperLiveKit returned an invalid transcription response.',
    });
  });

  it('bounds batch transcription requests that never complete', async () => {
    const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const transcriber = createWhisperLiveKitTranscriber(
      { baseUrl: 'http://127.0.0.1:8000', auth: 'none' },
      null,
      fetchMock as unknown as typeof fetch,
      1,
    );

    await expect(transcriber.transcribe({
      audio: new Uint8Array([1]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    })).rejects.toMatchObject({
      category: 'network',
      message: 'WhisperLiveKit transcription timed out. Try again.',
    });
  });

  it('streams ordered PCM and finalizes from late committed full-mode snapshots', async () => {
    const socket = new FakeSocket();
    const snapshots: Array<{ sequence: number; committed: string; tentative: string }> = [];
    const session = createWhisperLiveKitStreamingSession(
      { baseUrl: 'http://127.0.0.1:8000', auth: 'none' },
      null,
      {
        recognition: {
          language: 'en',
          task: 'transcribe',
          dictionary: [],
          removeFillerWords: false,
        },
        onSnapshot: (snapshot) => snapshots.push(snapshot),
      },
      {
        webSocketFactory: () => socket as unknown as NodeWebSocket,
        handshakeTimeoutMs: 100,
        stalledAudioTimeoutMs: 100,
        flushTimeoutMs: 100,
      },
    );

    socket.emit('open');
    socket.emit('message', new MessageEvent('message', {
      data: JSON.stringify({ type: 'config', useAudioWorklet: true, mode: 'full' }),
    }));
    await session.send(new Uint8Array(640).fill(7));
    socket.emit('message', new MessageEvent('message', {
      data: JSON.stringify({
        status: 'active_transcription',
        lines: [
          { speaker: 1, text: 'Hello ', start: '0:00:00', end: '0:00:01' },
          { speaker: -2, text: null, start: '0:00:01', end: '0:00:02' },
          { speaker: 1, text: 'world', start: '0:00:02', end: '0:00:03' },
        ],
        buffer_transcription: ' again',
      }),
    }));
    socket.emit('message', new MessageEvent('message', {
      data: JSON.stringify({
        status: 'no_audio_detected',
        lines: [],
        buffer_transcription: '',
      }),
    }));

    const finalized = session.finish();
    expect(socket.sent.map((frame) => frame.length)).toEqual([640, 0]);
    socket.emit('message', new MessageEvent('message', {
      data: JSON.stringify({
        status: 'active_transcription',
        lines: [
          { speaker: 1, text: 'Hello ', start: '0:00:00', end: '0:00:01' },
          { speaker: 1, text: 'world again', start: '0:00:02', end: '0:00:04' },
        ],
        buffer_transcription: '',
      }),
    }));
    socket.emit('message', new MessageEvent('message', {
      data: JSON.stringify({ type: 'ready_to_stop' }),
    }));

    await expect(finalized).resolves.toBe('Hello world again');
    expect(snapshots).toEqual([
      { sequence: 0, committed: 'Hello world', tentative: 'Hello world again' },
      { sequence: 1, committed: 'Hello world again', tentative: 'Hello world again' },
    ]);
    expect(socket.closed).toBe(true);
  });

  it('preserves word boundaries across silence lines when adjacent segments lack whitespace', async () => {
    const socket = new FakeSocket();
    const snapshots: Array<{ sequence: number; committed: string; tentative: string }> = [];
    const session = createWhisperLiveKitStreamingSession(
      { baseUrl: 'http://127.0.0.1:8000', auth: 'none' },
      null,
      {
        recognition: {
          language: 'en',
          task: 'transcribe',
          dictionary: [],
          removeFillerWords: false,
        },
        onSnapshot: (snapshot) => snapshots.push(snapshot),
      },
      {
        webSocketFactory: () => socket as unknown as NodeWebSocket,
        handshakeTimeoutMs: 100,
        stalledAudioTimeoutMs: 100,
        flushTimeoutMs: 100,
      },
    );

    socket.emit('open');
    socket.emit('message', new MessageEvent('message', {
      data: JSON.stringify({ type: 'config', useAudioWorklet: true, mode: 'full' }),
    }));
    await session.send(new Uint8Array(640).fill(7));
    socket.emit('message', new MessageEvent('message', {
      data: JSON.stringify({
        status: 'active_transcription',
        lines: [
          { speaker: 1, text: 'Hello', start: '0:00:00', end: '0:00:01' },
          { speaker: -2, text: null, start: '0:00:01', end: '0:00:02' },
          { speaker: 1, text: 'world', start: '0:00:02', end: '0:00:03' },
        ],
        buffer_transcription: '',
      }),
    }));

    expect(snapshots).toEqual([
      { sequence: 0, committed: 'Hello world', tentative: 'Hello world' },
    ]);
    session.cancel();
  });

  it('bounds a per-utterance handshake and final flush', async () => {
    const handshakeSocket = new FakeSocket();
    const stalledHandshake = createWhisperLiveKitStreamingSession(
      { baseUrl: 'http://127.0.0.1:8000', auth: 'none' },
      null,
      {
        recognition: {
          language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false,
        },
        onSnapshot: () => undefined,
      },
      {
        webSocketFactory: () => handshakeSocket as unknown as NodeWebSocket,
        handshakeTimeoutMs: 1,
      },
    );
    await expect(stalledHandshake.send(new Uint8Array(640))).rejects.toMatchObject({
      category: 'network',
      message: 'WhisperLiveKit PCM handshake timed out. Falling back to Batch Dictation.',
    });
    expect(handshakeSocket.closed).toBe(true);

    const flushSocket = new FakeSocket();
    const stalledFlush = createWhisperLiveKitStreamingSession(
      { baseUrl: 'http://127.0.0.1:8000', auth: 'none' },
      null,
      {
        recognition: {
          language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false,
        },
        onSnapshot: () => undefined,
      },
      {
        webSocketFactory: () => flushSocket as unknown as NodeWebSocket,
        handshakeTimeoutMs: 100,
        stalledAudioTimeoutMs: 100,
        flushTimeoutMs: 1,
      },
    );
    flushSocket.emit('open');
    flushSocket.emit('message', new MessageEvent('message', {
      data: JSON.stringify({ type: 'config', useAudioWorklet: true, mode: 'full' }),
    }));

    await expect(stalledFlush.finish()).rejects.toMatchObject({
      category: 'network',
      message: 'WhisperLiveKit finalization timed out. Falling back to Batch Dictation.',
    });
    expect(flushSocket.sent.map((frame) => frame.length)).toEqual([0]);
    expect(flushSocket.closed).toBe(true);
  });

  it('reports ready only after a healthy service passes the PCM WebSocket handshake', async () => {
    const socket = new FakeSocket();
    const fetcher = mock(() => Promise.resolve(new Response(
      JSON.stringify({ status: 'ok', backend: 'faster-whisper', ready: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const webSocketFactory = mock(() => {
      queueMicrotask(() => {
        socket.emit('open');
        socket.emit('message', new MessageEvent('message', {
          data: JSON.stringify({ type: 'config', useAudioWorklet: true, mode: 'full' }),
        }));
      });
      return socket as unknown as WebSocket;
    });

    const readiness = await checkWhisperLiveKitReadiness(
      { baseUrl: 'http://127.0.0.1:8000', auth: 'bearer' },
      'secret-token',
      { fetcher: fetcher as unknown as typeof fetch, webSocketFactory, handshakeRetryDelaysMs: [] },
    );

    expect(readiness).toMatchObject({ state: 'ready', providerId: 'whisper-live-kit' });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/health',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer secret-token' },
      }),
    );
    expect(webSocketFactory).toHaveBeenCalledWith(
      'ws://127.0.0.1:8000/asr?mode=full',
      { Authorization: 'Bearer secret-token' },
    );
    expect(socket.closed).toBe(true);
  });

  it('reports unavailable without opening a socket when health is not ready', async () => {
    const fetcher = mock(() => Promise.resolve(new Response(
      JSON.stringify({ status: 'ok', ready: false }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const webSocketFactory = mock(() => new FakeSocket() as unknown as WebSocket);

    const readiness = await checkWhisperLiveKitReadiness(
      { baseUrl: 'http://127.0.0.1:8000', auth: 'none' },
      null,
      { fetcher: fetcher as unknown as typeof fetch, webSocketFactory, handshakeRetryDelaysMs: [] },
    );

    expect(readiness).toMatchObject({ state: 'unavailable' });
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it('aborts a health request and reports unavailable when the health deadline expires', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetcher = mock((_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const webSocketFactory = mock(() => new FakeSocket() as unknown as WebSocket);

    const readiness = await checkWhisperLiveKitReadiness(
      { baseUrl: 'http://127.0.0.1:8000', auth: 'none' },
      null,
      {
        fetcher: fetcher as unknown as typeof fetch,
        webSocketFactory,
        healthTimeoutMs: 1,
        handshakeRetryDelaysMs: [],
      },
    );

    expect(readiness).toMatchObject({ state: 'unavailable' });
    expect(requestSignal?.aborted).toBe(true);
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it('reports degraded after bounded handshake retries without exposing socket errors', async () => {
    const fetcher = mock(() => Promise.resolve(new Response(
      JSON.stringify({ status: 'ok', ready: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const sockets: FakeSocket[] = [];
    const webSocketFactory = mock(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.emit('error'));
      return socket as unknown as WebSocket;
    });

    const readiness = await checkWhisperLiveKitReadiness(
      { baseUrl: 'http://127.0.0.1:8000', auth: 'none' },
      null,
      {
        fetcher: fetcher as unknown as typeof fetch,
        webSocketFactory,
        handshakeRetryDelaysMs: [0, 0],
      },
    );

    expect(readiness).toMatchObject({
      state: 'degraded',
      message: 'WhisperLiveKit health is ready, but its PCM WebSocket handshake failed.',
    });
    expect(webSocketFactory).toHaveBeenCalledTimes(3);
    expect(sockets.every((socket) => socket.closed)).toBe(true);
    expect(readiness.message).not.toContain('secret');
  });

  it('matches the running service health and handshake contract when explicitly requested', async () => {
    if (process.env.SHUDDHALEKHAN_TEST_REAL_WHISPERLIVEKIT !== '1') return;

    const readiness = await checkWhisperLiveKitReadiness(
      { baseUrl: 'http://127.0.0.1:8000', auth: 'none' },
      null,
      {
        fetcher: (Bun as unknown as { fetch: typeof fetch }).fetch,
      },
    );

    expect(readiness.state).toBe('ready');
  });

});
