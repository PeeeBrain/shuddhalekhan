import { describe, expect, it } from 'bun:test';
import {
  createRecordingPresentationEnvelope,
  getDictationCombinationError,
  getDictationRuntimeError,
  getFormatterProfileError,
  getFormatterCredentialError,
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
      formatter: {
        baseUrl: ' http://127.0.0.1:11434/v1 ',
        model: ' formatter ',
        apiKeyEnvVar: ' FORMATTER_KEY ',
        apiKeySource: 'stored',
        processingConsent: true,
      },
    });

    expect(once).toEqual({
      mode: 'corrected',
      formatter: {
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'formatter',
        apiKeyEnvVar: 'FORMATTER_KEY',
        apiKeySource: 'stored',
        processingConsent: true,
      },
    });
    expect(normalizeDictationConfig(once)).toEqual(once);
  });

  it('keeps every provider batch-capable and exposes streaming only for WhisperLiveKit', () => {
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
    expect(getTranscriptionTransportCapabilities('whisper-live-kit')).toEqual({
      batch: true,
      streaming: true,
    });
  });

  it('accepts local HTTP and remote HTTPS formatter profiles but rejects unsafe endpoints', () => {
    const baseProfile = {
      model: 'formatter',
      apiKeyEnvVar: '',
      apiKeySource: 'environment' as const,
      processingConsent: true,
    };
    expect(getFormatterProfileError({
      baseUrl: 'http://127.0.0.1:11434/v1',
      ...baseProfile,
    })).toBeNull();
    expect(getFormatterProfileError({
      baseUrl: 'https://formatter.example.com/v1',
      ...baseProfile,
    })).toBeNull();
    expect(getFormatterProfileError({
      baseUrl: 'http://formatter.example.com/v1',
      ...baseProfile,
    })).toBe('Remote Corrected Dictation formatters must use HTTPS.');
    expect(getFormatterProfileError({
      baseUrl: 'http://127.0.0.1.example.com/v1',
      ...baseProfile,
    })).toBe('Remote Corrected Dictation formatters must use HTTPS.');
    expect(getFormatterProfileError({
      baseUrl: 'https://secret@example.com/v1',
      ...baseProfile,
    })).toBe('Corrected Dictation formatter URLs cannot contain credentials.');
  });

  it('requires processing consent and remote credential references for Corrected Dictation', () => {
    const formatter = {
      baseUrl: 'https://formatter.example.com/v1',
      model: 'formatter',
      apiKeyEnvVar: '',
      apiKeySource: 'environment' as const,
      processingConsent: false,
    };
    expect(getDictationCombinationError({
      mode: 'corrected',
      activationMode: 'push-to-talk',
      capabilities: { batch: true, streaming: false },
      formatter,
    })).toBe('Corrected Dictation requires explicit processing consent.');

    expect(getDictationCombinationError({
      mode: 'corrected',
      activationMode: 'push-to-talk',
      capabilities: { batch: true, streaming: false },
      formatter: { ...formatter, processingConsent: true },
    })).toBe('Remote Corrected Dictation requires an API key environment variable.');

    expect(getFormatterCredentialError({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'formatter',
      apiKeyEnvVar: 'sk-test-key',
      apiKeySource: 'environment',
      processingConsent: true,
    })).toBe('Enter the environment variable name for the formatter API key, not the key value.');
  });
});

describe('maintainer runtime gates', () => {
  it('enables the runtime shell, agent shell, streaming, and direct-Unicode paths by default', () => {
    expect(parseMaintainerRuntimeGates({})).toEqual({
      runtimeShell: true,
      agentShell: true,
      streaming: true,
      directUnicode: true,
    });
  });

  it('disables each local path independently without a remote rollout switch', () => {
    expect(parseMaintainerRuntimeGates({
      SHUDDHALEKHAN_DISABLE_RUNTIME_SHELL: '1',
    })).toEqual({
      runtimeShell: false,
      agentShell: true,
      streaming: true,
      directUnicode: true,
    });
    expect(parseMaintainerRuntimeGates({
      SHUDDHALEKHAN_DISABLE_AGENT_SHELL: '1',
    })).toEqual({
      runtimeShell: true,
      agentShell: false,
      streaming: true,
      directUnicode: true,
    });
    expect(parseMaintainerRuntimeGates({
      SHUDDHALEKHAN_DISABLE_STREAMING: '1',
    })).toEqual({
      runtimeShell: true,
      agentShell: true,
      streaming: false,
      directUnicode: true,
    });
    expect(parseMaintainerRuntimeGates({
      SHUDDHALEKHAN_DISABLE_DIRECT_UNICODE: '1',
    })).toEqual({
      runtimeShell: true,
      agentShell: true,
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
      agentShell: true,
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
      agentShell: true,
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
