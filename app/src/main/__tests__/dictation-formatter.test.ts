import { afterEach, describe, expect, it } from 'bun:test';
import type { DictationFormatterProfile } from '../../types/ipc';
import {
  applyDictationFormatter,
  FORMATTER_MAX_INPUT_CODE_UNITS,
  validateFormatterOutput,
} from '../dictation-formatter';
import { FORMATTER_CORPUS } from './fixtures/dictation-formatter-corpus';

const profile: DictationFormatterProfile = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'formatter',
  apiKeyEnvVar: '',
  apiKeySource: 'environment',
  processingConsent: true,
};

function jsonResponse(correctedText: string) {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({ correctedText }),
      },
    }],
  }), { status: 200 });
}

describe('validateFormatterOutput', () => {
  it('rejects empty, control-bearing, and excessively expanded formatter output', () => {
    expect(validateFormatterOutput('hello world', '', 'en')).toMatch(/empty/i);
    expect(validateFormatterOutput('hello', 'hello\x07', 'en')).toMatch(/control/i);
    expect(validateFormatterOutput('hi', 'x'.repeat(600), 'en')).toMatch(/expanded/i);
  });

  it('accepts conservative corrections from the pinned corpus', () => {
    for (const fixture of FORMATTER_CORPUS) {
      for (const output of fixture.acceptableOutputs) {
        expect(validateFormatterOutput(
          fixture.raw,
          output,
          fixture.language,
          fixture.protectedTerms ?? [],
        )).toBeNull();
      }
    }
  });

  it('rejects unsafe corpus outputs without meaning-changing false positives', () => {
    for (const fixture of FORMATTER_CORPUS) {
      for (const output of fixture.rejectedOutputs) {
        expect(validateFormatterOutput(
          fixture.raw,
          output,
          fixture.language,
          fixture.protectedTerms ?? [],
        )).not.toBeNull();
      }
    }
  });

  it('rejects formatter output that drops protected spelling terms', () => {
    expect(validateFormatterOutput(
      'deploy Shuddhalekhan to Kubernetes tonight',
      'deploy the app tonight',
      'en',
      ['Shuddhalekhan', 'Kubernetes'],
    )).toMatch(/protected spelling/i);
  });
});

describe('applyDictationFormatter', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns corrected text from structured formatter output', async () => {
    globalThis.fetch = async () => jsonResponse('buy eggs');

    const outcome = await applyDictationFormatter({
      profile,
      rawText: 'buy milk um actually buy eggs',
      language: 'en',
      protectedTerms: [],
      apiKey: null,
    });

    expect(outcome).toEqual({ kind: 'success', text: 'buy eggs' });
  });

  it('falls back to raw text on timeout, auth failure, oversized input, and invalid output', async () => {
    const raw = 'complete raw transcript';
    const oversized = 'a'.repeat(FORMATTER_MAX_INPUT_CODE_UNITS + 1);
    expect(await applyDictationFormatter({
      profile,
      rawText: oversized,
      language: 'en',
      protectedTerms: [],
      apiKey: null,
    })).toEqual({ kind: 'fallback', rawText: oversized, reason: 'oversized-input' });

    globalThis.fetch = async () => new Response('', { status: 401 });
    expect(await applyDictationFormatter({
      profile,
      rawText: raw,
      language: 'en',
      protectedTerms: [],
      apiKey: null,
    })).toEqual({ kind: 'fallback', rawText: raw, reason: 'authentication' });

    globalThis.fetch = async () => jsonResponse('');
    expect(await applyDictationFormatter({
      profile,
      rawText: raw,
      language: 'en',
      protectedTerms: [],
      apiKey: null,
    })).toEqual({ kind: 'fallback', rawText: raw, reason: 'invalid-output' });

    globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
    expect(await applyDictationFormatter({
      profile,
      rawText: raw,
      language: 'en',
      protectedTerms: [],
      apiKey: null,
      deadlineMs: 20,
    })).toEqual({ kind: 'fallback', rawText: raw, reason: 'deadline' });

    globalThis.fetch = async () => new Response('', { status: 500 });
    expect(await applyDictationFormatter({
      profile,
      rawText: raw,
      language: 'en',
      protectedTerms: [],
      apiKey: null,
    })).toEqual({ kind: 'fallback', rawText: raw, reason: 'provider-failure' });

    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'not-json' } }],
    }), { status: 200 });
    expect(await applyDictationFormatter({
      profile,
      rawText: raw,
      language: 'en',
      protectedTerms: [],
      apiKey: null,
    })).toEqual({ kind: 'fallback', rawText: raw, reason: 'malformed-response' });

    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    expect(await applyDictationFormatter({
      profile,
      rawText: raw,
      language: 'en',
      protectedTerms: [],
      apiKey: null,
    })).toEqual({ kind: 'fallback', rawText: raw, reason: 'network' });
  });
});
