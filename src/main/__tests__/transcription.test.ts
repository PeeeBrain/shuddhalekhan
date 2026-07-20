import { describe, expect, it } from 'bun:test';
import {
  checkServerReachability,
  getRecognitionCompatibilityErrors,
  getSafeTranscriptionFailureMessage,
  TranscriptionFailure,
  validateLocalWhisperSettings,
} from '../transcription';
import { LOCAL_WHISPER_CPP_CAPABILITIES } from '../whisper';

describe('transcription provider capabilities', () => {
  it('describes the local whisper.cpp recognition contract', () => {
    expect(LOCAL_WHISPER_CPP_CAPABILITIES).toEqual({
      translation: true,
      automaticLanguageDetection: true,
      dictionaryHints: true,
      authentication: 'none',
      maxDurationSeconds: null,
    });
  });

  it('reports recognition controls unsupported by a provider', () => {
    expect(getRecognitionCompatibilityErrors({
      language: 'auto',
      task: 'translate',
      dictionary: ['Shuddhalekhan'],
      removeFillerWords: true,
    }, {
      translation: false,
      automaticLanguageDetection: false,
      dictionaryHints: false,
      authentication: 'required',
      maxDurationSeconds: 55,
    })).toEqual([
      'Translation is not supported by this provider.',
      'Automatic language detection is not supported by this provider.',
      'Dictionary hints are not supported by this provider.',
    ]);
  });
});

describe('sanitized failures', () => {
  it('keeps normalized guidance and redacts unknown error material', () => {
    expect(getSafeTranscriptionFailureMessage(
      new TranscriptionFailure('rate-limit', 'The transcription provider rate limit was reached.'),
    )).toBe('The transcription provider rate limit was reached.');
    expect(getSafeTranscriptionFailureMessage(new Error('token=super-secret'))).toBe(
      'Transcription failed unexpectedly. Check provider settings and try again.',
    );
  });
});

describe('server reachability checks', () => {
  it('treats any HTTP response as reachable and sends no recording', async () => {
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init).toEqual({ method: 'HEAD' });
      expect(init?.body).toBeUndefined();
      return new Response(null, { status: 503 });
    };

    await expect(checkServerReachability(
      'http://localhost:8080/inference',
      fetcher as typeof fetch,
    )).resolves.toBe(true);
  });

  it('reports network failures as unreachable', async () => {
    const fetcher = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    await expect(checkServerReachability('http://localhost:8080/inference', fetcher)).resolves.toBe(false);
  });
});

describe('local whisper.cpp validation', () => {
  it('accepts HTTP inference endpoints and rejects unsafe protocols', () => {
    expect(validateLocalWhisperSettings({ endpoint: 'http://localhost:8080/inference' })).toEqual([]);
    expect(validateLocalWhisperSettings({ endpoint: 'file:///C:/secret' })).toEqual([
      'Endpoint must use HTTP or HTTPS.',
    ]);
    expect(validateLocalWhisperSettings({ endpoint: 'not a url' })).toEqual([
      'Enter a valid endpoint URL.',
    ]);
  });
});
