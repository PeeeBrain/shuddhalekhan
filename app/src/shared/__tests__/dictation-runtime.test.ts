import { describe, expect, it } from 'bun:test';
import {
  createRecordingPresentationEnvelope,
  getDictationCombinationError,
  getDictationRuntimeError,
  getFormatterProfileError,
  getTranscriptionTransportCapabilities,
  normalizeDictationConfig,
  parseMaintainerRuntimeGates,
} from '../dictation-runtime';

describe('Dictation config normalization', () => {
  it('normalizes missing and unsupported modes to the stable Batch shape', () => {
    expect(normalizeDictationConfig(undefined)).toEqual({ mode: 'batch', formatter: null });
    expect(normalizeDictationConfig({ mode: 'stream' })).toEqual({ mode: 'batch', formatter: null });
  });

  it('normalizes formatter values idempotently', () => {
    const once = normalizeDictationConfig({
      mode: 'corrected',
      formatter: { baseUrl: ' http://127.0.0.1:11434/v1 ', model: ' formatter ' },
    });

    expect(once).toEqual({
      mode: 'corrected',
      formatter: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'formatter' },
    });
    expect(normalizeDictationConfig(once)).toEqual(once);
  });

  it('declares every current transcription provider as batch-capable', () => {
    for (const providerId of [
      'local-whisper-cpp',
      'openai',
      'azure-speech',
      'google-cloud-speech-v2',
      'nvidia-speech-nim',
      'custom-open-ai-compatible',
    ] as const) {
      expect(getTranscriptionTransportCapabilities(providerId)).toEqual({
        batch: true,
        streaming: false,
      });
    }
  });

  it('accepts local HTTP and remote HTTPS formatter profiles but rejects unsafe endpoints', () => {
    expect(getFormatterProfileError({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'formatter',
    })).toBeNull();
    expect(getFormatterProfileError({
      baseUrl: 'https://formatter.example.com/v1',
      model: 'formatter',
    })).toBeNull();
    expect(getFormatterProfileError({
      baseUrl: 'http://formatter.example.com/v1',
      model: 'formatter',
    })).toBe('Remote Corrected Dictation formatters must use HTTPS.');
    expect(getFormatterProfileError({
      baseUrl: 'http://127.0.0.1.example.com/v1',
      model: 'formatter',
    })).toBe('Remote Corrected Dictation formatters must use HTTPS.');
    expect(getFormatterProfileError({
      baseUrl: 'https://secret@example.com/v1',
      model: 'formatter',
    })).toBe('Corrected Dictation formatter URLs cannot contain credentials.');
  });
});

describe('maintainer runtime gates', () => {
  it('enables the runtime shell, streaming, and direct-Unicode paths by default', () => {
    expect(parseMaintainerRuntimeGates({})).toEqual({
      runtimeShell: true,
      streaming: true,
      directUnicode: true,
    });
  });

  it('disables each local path independently without a remote rollout switch', () => {
    expect(parseMaintainerRuntimeGates({
      SHUDDHALEKHAN_DISABLE_RUNTIME_SHELL: '1',
    })).toEqual({
      runtimeShell: false,
      streaming: true,
      directUnicode: true,
    });
    expect(parseMaintainerRuntimeGates({
      SHUDDHALEKHAN_DISABLE_STREAMING: '1',
    })).toEqual({
      runtimeShell: true,
      streaming: false,
      directUnicode: true,
    });
    expect(parseMaintainerRuntimeGates({
      SHUDDHALEKHAN_DISABLE_DIRECT_UNICODE: '1',
    })).toEqual({
      runtimeShell: true,
      streaming: true,
      directUnicode: false,
    });
  });

  it('keeps Live Dictation unavailable when streaming is locally disabled', () => {
    const combination = {
      mode: 'live' as const,
      activationMode: 'toggle' as const,
      capabilities: { batch: true as const, streaming: true },
      formatter: null,
    };

    expect(getDictationCombinationError(combination)).toBeNull();
    expect(getDictationRuntimeError(combination, {
      runtimeShell: true,
      streaming: false,
      directUnicode: true,
    })).toBe('Live Dictation is disabled by a local maintainer switch.');
  });

  it('keeps direct-Unicode gating independent from persisted combination validity', () => {
    const combination = {
      mode: 'live' as const,
      activationMode: 'toggle' as const,
      capabilities: { batch: true as const, streaming: true },
      formatter: null,
    };

    expect(getDictationRuntimeError(combination, {
      runtimeShell: true,
      streaming: true,
      directUnicode: false,
    })).toBe('Direct-Unicode insertion is disabled by a local maintainer switch.');
  });
});

describe('recording presentation envelope', () => {
  it('carries session identity, revision, capabilities, and a typed outcome without replacing the session id', () => {
    const envelope = createRecordingPresentationEnvelope({
      recordingSessionId: 'session-1',
      sequence: 3,
      revision: 2,
      capabilities: { batch: true, streaming: false },
      outcome: { kind: 'completed' },
    });

    expect(envelope.recordingSessionId).toBe('session-1');
    expect(envelope.sequence).toBe(3);
    expect(envelope.revision).toBe(2);
    expect(envelope.capabilities).toEqual({ batch: true, streaming: false });
    expect(envelope.outcome).toEqual({ kind: 'completed' });
  });
});
