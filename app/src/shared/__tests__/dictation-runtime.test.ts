import { describe, expect, it } from 'bun:test';
import { TRANSCRIPTION_PROVIDER_IDS } from '@shuddhalekhan/shared/providers';
import {
  getDictationConfigError,
  getFormatterProfileError,
  getFormatterCredentialError,
  getTranscriptionTransportCapabilities,
  normalizeDictationConfig,
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

  it('keeps batch dictation available while enabling streaming only for WhisperLiveKit', () => {
    for (const providerId of TRANSCRIPTION_PROVIDER_IDS) {
      expect(getTranscriptionTransportCapabilities(providerId)).toEqual({
        batch: true,
        streaming: providerId === 'whisper-live-kit',
      });
    }
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
    expect(getDictationConfigError({ mode: 'corrected', formatter })).toBe('Corrected Dictation requires explicit processing consent.');

    expect(getDictationConfigError({ mode: 'corrected', formatter: { ...formatter, processingConsent: true } })).toBe('Remote Corrected Dictation requires an API key environment variable.');

    expect(getFormatterCredentialError({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'formatter',
      apiKeyEnvVar: 'sk-test-key',
      apiKeySource: 'environment',
      processingConsent: true,
    })).toBe('Enter the environment variable name for the formatter API key, not the key value.');
  });
});
