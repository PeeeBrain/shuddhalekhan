import type {
  TranscriptionReadiness,
  WhisperLiveKitProviderConfig,
} from '../types/ipc';
import WebSocket from 'ws';
import {
  cleanFillerWords,
  failureForHttpStatus,
  validateWhisperLiveKitSettings,
  type RecognitionSettings,
  type StreamingTranscriptionRequest,
  type StreamingTranscriptionSession,
  type StreamingTranscriptSnapshot,
  type Transcriber,
  type TranscriptionCapabilities,
  TranscriptionFailure,
} from './transcription';

export { validateWhisperLiveKitSettings } from './transcription';

export interface WhisperLiveKitEndpoints {
  baseUrl: string;
  transcription: string;
  health: string;
  websocket: string;
}

export const WHISPER_LIVE_KIT_CAPABILITIES: TranscriptionCapabilities = {
  translation: false,
  automaticLanguageDetection: true,
  dictionaryHints: false,
  authentication: 'optional',
  maxDurationSeconds: null,
};

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_BATCH_TIMEOUT_MS = 60_000;
const DEFAULT_STALLED_AUDIO_TIMEOUT_MS = 2_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;
const DEFAULT_HANDSHAKE_RETRY_DELAYS_MS = [250, 1_000];

interface WhisperLiveKitReadinessOptions {
  fetcher?: typeof fetch;
  webSocketFactory?: (
    url: string,
    headers?: Record<string, string>,
  ) => WebSocket;
  healthTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  handshakeRetryDelaysMs?: number[];
}

export async function checkWhisperLiveKitReadiness(
  config: WhisperLiveKitProviderConfig,
  savedBearerToken: string | null,
  options: WhisperLiveKitReadinessOptions = {},
): Promise<TranscriptionReadiness> {
  const checkedAt = new Date().toISOString();
  const invalidSettings = validateWhisperLiveKitSettings(config);
  if (invalidSettings.length > 0) {
    return {
      providerId: 'whisper-live-kit',
      state: 'unavailable',
      message: invalidSettings[0]!,
      checkedAt,
    };
  }

  if (config.auth === 'bearer' && !savedBearerToken) {
    return {
      providerId: 'whisper-live-kit',
      state: 'unavailable',
      message: 'WhisperLiveKit bearer token is not configured. Save it in Settings.',
      checkedAt,
    };
  }

  const endpoints = buildWhisperLiveKitEndpoints(config);
  const headers = config.auth === 'bearer' && savedBearerToken
    ? { Authorization: `Bearer ${savedBearerToken}` }
    : undefined;
  const fetcher = options.fetcher ?? fetch;

  let healthReady = false;
  const healthAbortController = new AbortController();
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  let healthTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const response = await Promise.race([
      fetcher(endpoints.health, {
        method: 'GET',
        signal: healthAbortController.signal,
        ...(headers ? { headers } : {}),
      }),
      new Promise<never>((_resolve, reject) => {
        healthTimer = setTimeout(() => {
          healthAbortController.abort();
          reject(new Error('WhisperLiveKit health check timed out.'));
        }, healthTimeoutMs);
      }),
    ]);
    if (response.ok) {
      const data = await response.json() as unknown;
      healthReady = isHealthyWhisperLiveKitResponse(data);
    }
  } catch {
    healthReady = false;
  } finally {
    if (healthTimer) clearTimeout(healthTimer);
  }

  if (!healthReady) {
    return {
      providerId: 'whisper-live-kit',
      state: 'unavailable',
      message: 'WhisperLiveKit is unavailable. Check that the service is running and ready.',
      checkedAt,
    };
  }

  const webSocketHeaders = config.auth === 'bearer' && savedBearerToken
    ? { Authorization: `Bearer ${savedBearerToken}` }
    : undefined;
  const webSocketFactory = options.webSocketFactory
    ?? ((url: string, socketHeaders?: Record<string, string>) => new WebSocket(
      url,
      socketHeaders ? { headers: socketHeaders } : undefined,
    ));
  const retryDelays = options.handshakeRetryDelaysMs ?? DEFAULT_HANDSHAKE_RETRY_DELAYS_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    const handshake = await probeWhisperLiveKitHandshake(
      endpoints.websocket,
      webSocketHeaders,
      webSocketFactory,
      handshakeTimeoutMs,
    );
    if (handshake.ok) {
      return {
        providerId: 'whisper-live-kit',
        state: 'ready',
        message: 'WhisperLiveKit is ready for Batch and Live Dictation.',
        checkedAt,
      };
    }

    const retryDelay = retryDelays[attempt];
    if (retryDelay === undefined) break;
    await delay(retryDelay);
  }

  return {
    providerId: 'whisper-live-kit',
    state: 'degraded',
    message: 'WhisperLiveKit health is ready, but its PCM WebSocket handshake failed.',
    checkedAt,
  };
}

interface WhisperLiveKitStreamingOptions {
  webSocketFactory?: (
    url: string,
    headers?: Record<string, string>,
  ) => WebSocket;
  handshakeTimeoutMs?: number;
  stalledAudioTimeoutMs?: number;
  flushTimeoutMs?: number;
}

interface WhisperLiveKitLine {
  speaker: number;
  text: string | null;
}

export function createWhisperLiveKitStreamingSession(
  config: WhisperLiveKitProviderConfig,
  savedBearerToken: string | null,
  request: StreamingTranscriptionRequest,
  options: WhisperLiveKitStreamingOptions = {},
): StreamingTranscriptionSession {
  const settingsErrors = validateWhisperLiveKitSettings(config);
  if (settingsErrors.length > 0) {
    throw new TranscriptionFailure('endpoint', settingsErrors[0]!);
  }
  if (request.recognition.task === 'translate') {
    throw new TranscriptionFailure('model', 'WhisperLiveKit streaming does not support translation.');
  }
  if (config.auth === 'bearer' && !savedBearerToken) {
    throw new TranscriptionFailure(
      'authentication',
      'WhisperLiveKit bearer token is not configured. Save it in Settings.',
    );
  }

  const endpoint = new URL(buildWhisperLiveKitEndpoints(config).websocket);
  endpoint.searchParams.set('language', request.recognition.language);
  const headers = config.auth === 'bearer' && savedBearerToken
    ? { Authorization: `Bearer ${savedBearerToken}` }
    : undefined;
  const webSocketFactory = options.webSocketFactory
    ?? ((url: string, socketHeaders?: Record<string, string>) => new WebSocket(
      url,
      socketHeaders ? { headers: socketHeaders } : undefined,
    ));
  const socket = webSocketFactory(endpoint.toString(), headers);
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const stalledAudioTimeoutMs = options.stalledAudioTimeoutMs ?? DEFAULT_STALLED_AUDIO_TIMEOUT_MS;
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  let opened = false;
  let configured = false;
  let terminal = false;
  let finishing = false;
  let snapshotSequence = 0;
  let committed = '';
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveFinal!: (text: string) => void;
  let rejectFinal!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const final = new Promise<string>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });
  void ready.catch(() => undefined);
  void final.catch(() => undefined);

  const cleanup = (): void => {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    if (flushTimer) clearTimeout(flushTimer);
    socket.removeEventListener('open', onOpen);
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('error', onSocketFailure);
    socket.removeEventListener('close', onSocketFailure);
  };
  const closeSocket = (): void => {
    try {
      socket.close();
    } catch {
      // The socket is already terminal.
    }
  };
  const fail = (message: string): void => {
    if (terminal) return;
    terminal = true;
    const error = new TranscriptionFailure('network', message);
    cleanup();
    closeSocket();
    if (!configured) rejectReady(error);
    rejectFinal(error);
  };
  const onOpen = (): void => {
    opened = true;
  };
  const onSocketFailure = (): void => {
    fail('WhisperLiveKit streaming connection failed. Falling back to Batch Dictation.');
  };
  const publishSnapshot = (value: unknown): void => {
    if (isWhisperLiveKitNoAudioSnapshot(value)) return;
    const snapshot = parseWhisperLiveKitFullSnapshot(value, snapshotSequence);
    if (!snapshot) {
      fail('WhisperLiveKit returned an invalid streaming response. Falling back to Batch Dictation.');
      return;
    }
    snapshotSequence += 1;
    committed = snapshot.committed;
    request.onSnapshot(snapshot);
  };
  const onMessage = (event: WebSocket.MessageEvent): void => {
    if (typeof event.data !== 'string') {
      fail('WhisperLiveKit returned an invalid streaming response. Falling back to Batch Dictation.');
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      fail('WhisperLiveKit returned an invalid streaming response. Falling back to Batch Dictation.');
      return;
    }
    if (!configured) {
      if (!opened || !isWhisperLiveKitPcmConfig(value)) {
        fail('WhisperLiveKit PCM handshake failed. Falling back to Batch Dictation.');
        return;
      }
      configured = true;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      resolveReady();
      return;
    }
    if (isReadyToStop(value)) {
      if (!finishing) {
        fail('WhisperLiveKit ended the stream before finalization. Falling back to Batch Dictation.');
        return;
      }
      terminal = true;
      cleanup();
      closeSocket();
      resolveFinal(committed);
      return;
    }
    publishSnapshot(value);
  };

  socket.addEventListener('open', onOpen);
  socket.addEventListener('message', onMessage);
  socket.addEventListener('error', onSocketFailure);
  socket.addEventListener('close', onSocketFailure);
  handshakeTimer = setTimeout(() => {
    fail('WhisperLiveKit PCM handshake timed out. Falling back to Batch Dictation.');
  }, handshakeTimeoutMs);

  const send = async (pcm: Uint8Array): Promise<void> => {
    await ready;
    if (terminal || finishing) {
      throw new TranscriptionFailure('network', 'WhisperLiveKit streaming session is closed.');
    }
    await sendWebSocketBinary(socket, pcm, stalledAudioTimeoutMs);
  };

  return {
    send,
    finish() {
      const beginFinish = async (): Promise<void> => {
        if (!finishing && !terminal) {
          if (!configured) await ready;
          finishing = true;
          await sendWebSocketBinary(socket, new Uint8Array(), stalledAudioTimeoutMs);
          flushTimer = setTimeout(() => {
            fail('WhisperLiveKit finalization timed out. Falling back to Batch Dictation.');
          }, flushTimeoutMs);
        }
      };
      return beginFinish().then(() => final);
    },
    cancel() {
      if (terminal) return;
      terminal = true;
      const error = new TranscriptionFailure('network', 'WhisperLiveKit streaming was cancelled.');
      cleanup();
      closeSocket();
      if (!configured) rejectReady(error);
      rejectFinal(error);
    },
  };
}

export function createWhisperLiveKitTranscriber(
  config: WhisperLiveKitProviderConfig,
  savedBearerToken: string | null,
  fetcher: typeof fetch = fetch,
  batchTimeoutMs = DEFAULT_BATCH_TIMEOUT_MS,
): Transcriber {
  return {
    id: 'whisper-live-kit',
    capabilities: WHISPER_LIVE_KIT_CAPABILITIES,
    transportCapabilities: { batch: true, streaming: true },
    startStreaming(request) {
      return createWhisperLiveKitStreamingSession(config, savedBearerToken, request);
    },
    async transcribe({ audio, recognition }) {
      const settingsErrors = validateWhisperLiveKitSettings(config);
      if (settingsErrors.length > 0) {
        throw new TranscriptionFailure('endpoint', settingsErrors[0]!);
      }
      if (recognition.task === 'translate') {
        throw new TranscriptionFailure(
          'model',
          'WhisperLiveKit batch transcription does not support translation.',
        );
      }

      const endpoints = buildWhisperLiveKitEndpoints(config);
      const headers: Record<string, string> = {};
      if (config.auth === 'bearer') {
        if (!savedBearerToken) {
          throw new TranscriptionFailure(
            'authentication',
            'WhisperLiveKit bearer token is not configured. Save it in Settings.',
          );
        }
        headers.Authorization = `Bearer ${savedBearerToken}`;
      }

      return transcribeWhisperLiveKit(
        audio,
        recognition,
        endpoints.transcription,
        headers,
        fetcher,
        batchTimeoutMs,
      );
    },
  };
}

export function deriveWhisperLiveKitEndpoints(baseUrl: string): WhisperLiveKitEndpoints {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  const parsed = new URL(normalized);
  const websocketProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
  const websocketBase = `${websocketProtocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');

  return {
    baseUrl: base,
    transcription: `${base}/v1/audio/transcriptions`,
    health: `${base}/health`,
    websocket: `${websocketBase}/asr?mode=full`,
  };
}

export function buildWhisperLiveKitEndpoints(
  config: WhisperLiveKitProviderConfig,
): WhisperLiveKitEndpoints {
  return deriveWhisperLiveKitEndpoints(config.baseUrl);
}

function isWhisperLiveKitPcmConfig(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const config = value as { type?: unknown; useAudioWorklet?: unknown; mode?: unknown };
  return config.type === 'config' && config.useAudioWorklet === true && config.mode === 'full';
}

function isReadyToStop(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { type?: unknown }).type === 'ready_to_stop');
}

function isWhisperLiveKitNoAudioSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as {
    type?: unknown;
    status?: unknown;
    lines?: unknown;
    buffer_transcription?: unknown;
    error?: unknown;
  };
  return record.type === undefined
    && record.error === undefined
    && record.status === 'no_audio_detected'
    && Array.isArray(record.lines)
    && record.lines.length === 0
    && record.buffer_transcription === '';
}

function parseWhisperLiveKitFullSnapshot(
  value: unknown,
  sequence: number,
): StreamingTranscriptSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as {
    type?: unknown;
    status?: unknown;
    lines?: unknown;
    buffer_transcription?: unknown;
    error?: unknown;
  };
  if (record.type !== undefined || record.error !== undefined) return null;
  if (record.status !== 'active_transcription' && record.status !== 'no_audio_detected') return null;
  if (!Array.isArray(record.lines) || typeof record.buffer_transcription !== 'string') return null;

  const lines: WhisperLiveKitLine[] = [];
  for (const item of record.lines) {
    if (!item || typeof item !== 'object') return null;
    const line = item as { speaker?: unknown; text?: unknown };
    if (typeof line.speaker !== 'number') return null;
    if (line.text !== null && typeof line.text !== 'string') return null;
    lines.push({ speaker: line.speaker, text: line.text });
  }
  const committed = lines
    .filter((line) => line.speaker !== -2)
    .map((line) => line.text ?? '')
    .join('');
  return {
    sequence,
    committed,
    tentative: `${committed}${record.buffer_transcription}`,
  };
}

function sendWebSocketBinary(
  socket: WebSocket,
  data: Uint8Array,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TranscriptionFailure(
        'network',
        'WhisperLiveKit stopped accepting audio. Falling back to Batch Dictation.',
      ));
    }, timeoutMs);
    socket.send(data, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(new TranscriptionFailure(
          'network',
          'WhisperLiveKit stopped accepting audio. Falling back to Batch Dictation.',
        ));
      } else {
        resolve();
      }
    });
  });
}

function isHealthyWhisperLiveKitResponse(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const response = value as { status?: unknown; ready?: unknown };
  return response.status === 'ok' && response.ready === true;
}

async function probeWhisperLiveKitHandshake(
  endpoint: string,
  headers: Record<string, string> | undefined,
  webSocketFactory: (url: string, headers?: Record<string, string>) => WebSocket,
  timeoutMs: number,
): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let opened = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (socket) {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('error', onFailure);
        socket.removeEventListener('close', onFailure);
        try {
          socket.close();
        } catch {
          // The socket is already terminal; no further action is safe.
        }
      }
      resolve({ ok });
    };

    const onMessage = (event: WebSocket.MessageEvent): void => {
      if (!opened) return finish(false);
      if (typeof event.data !== 'string') return finish(false);
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return finish(false);
      }
      if (!data || typeof data !== 'object') return finish(false);
      const message = data as { type?: unknown; useAudioWorklet?: unknown; mode?: unknown };
      if (message.type !== 'config') return finish(false);
      finish(message.useAudioWorklet === true && message.mode === 'full');
    };
    const onOpen = (): void => {
      opened = true;
    };
    const onFailure = (): void => finish(false);

    try {
      socket = webSocketFactory(endpoint, headers);
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onFailure);
      socket.addEventListener('close', onFailure);
      timer = setTimeout(() => finish(false), timeoutMs);
    } catch {
      finish(false);
    }
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function transcribeWhisperLiveKit(
  audio: Uint8Array,
  recognition: RecognitionSettings,
  endpoint: string,
  headers: Record<string, string>,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([audio as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }),
    'audio.wav',
  );
  form.append('response_format', 'json');
  if (recognition.language !== 'auto') form.append('language', recognition.language);

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers,
      body: form as unknown as BodyInit,
      signal: abortController.signal,
    });
  } catch {
    clearTimeout(timeout);
    if (abortController.signal.aborted) {
      throw new TranscriptionFailure(
        'network',
        'WhisperLiveKit transcription timed out. Try again.',
      );
    }
    throw new TranscriptionFailure(
      'network',
      'Could not reach WhisperLiveKit. Check the endpoint and network connection.',
    );
  }

  if (!response.ok) {
    clearTimeout(timeout);
    throw failureForHttpStatus(response.status, 'WhisperLiveKit');
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    if (abortController.signal.aborted) {
      throw new TranscriptionFailure(
        'network',
        'WhisperLiveKit transcription timed out. Try again.',
      );
    }
    throw new TranscriptionFailure(
      'malformed-response',
      'WhisperLiveKit returned an invalid transcription response.',
    );
  } finally {
    clearTimeout(timeout);
  }

  const rawText = data && typeof data === 'object' && 'text' in data
    ? (data as { text?: unknown }).text
    : undefined;
  if (typeof rawText !== 'string') {
    throw new TranscriptionFailure(
      'malformed-response',
      'WhisperLiveKit returned an invalid transcription response.',
    );
  }

  return recognition.removeFillerWords ? cleanFillerWords(rawText.trim()) : rawText.trim();
}
