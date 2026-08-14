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
        message: 'WhisperLiveKit is ready for Batch Dictation.',
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

export function createWhisperLiveKitTranscriber(
  config: WhisperLiveKitProviderConfig,
  savedBearerToken: string | null,
  fetcher: typeof fetch = fetch,
): Transcriber {
  return {
    id: 'whisper-live-kit',
    capabilities: WHISPER_LIVE_KIT_CAPABILITIES,
    transportCapabilities: { batch: true, streaming: false },
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
): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'json');
  if (recognition.language !== 'auto') form.append('language', recognition.language);

  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers,
      body: form as unknown as BodyInit,
    });
  } catch {
    throw new TranscriptionFailure(
      'network',
      'Could not reach WhisperLiveKit. Check the endpoint and network connection.',
    );
  }

  if (!response.ok) throw failureForHttpStatus(response.status, 'WhisperLiveKit');

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new TranscriptionFailure(
      'malformed-response',
      'WhisperLiveKit returned an invalid transcription response.',
    );
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
