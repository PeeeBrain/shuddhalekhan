import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { TranscriptionRequest } from '../transcription';
import { createSarvamTranscriber } from '../sarvam';
import { DEFAULT_SARVAM_CONFIG, getSarvamSettingsErrors } from '../../shared/sarvam';

const recognition = { language: 'hi', task: 'transcribe', dictionary: ['PhonePe'], removeFillerWords: false } as const;
const request = (): TranscriptionRequest => ({ audio: new Uint8Array([1, 2, 3]), recognition: { ...recognition, dictionary: [...recognition.dictionary] } });

describe('Sarvam transcription', () => {
  afterEach(() => { fetchSpy?.mockRestore(); });
  let fetchSpy: ReturnType<typeof spyOn>;

  it('uploads WAV with subscription authentication, BCP-47 language, model, mode, and JSON keyterms', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ transcript: '  नमस्ते PhonePe  ' }));
    const transcriber = createSarvamTranscriber({ ...DEFAULT_SARVAM_CONFIG, mode: 'codemix' }, 'secret');
    expect(await transcriber.transcribe(request())).toBe('नमस्ते PhonePe');
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.sarvam.ai/speech-to-text');
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.headers).toEqual({ 'api-subscription-key': 'secret' });
    const body = init?.body;
    expect(body).toBeInstanceOf(FormData);
    if (!(body instanceof FormData)) throw new Error('Expected multipart upload');
    expect(body.get('model')).toBe('saaras:v4');
    expect(body.get('mode')).toBe('codemix');
    expect(body.get('language_code')).toBe('hi-IN');
    expect(body.get('keyterms')).toBe('["PhonePe"]');
    const file = body.get('file');
    if (!(file instanceof Blob)) throw new Error('Expected WAV file');
    expect(await file.arrayBuffer()).toEqual(request().audio.buffer);
    expect(transcriber.capabilities.maxDurationSeconds).toBe(30);
  });

  it('omits unsupported v3 keyterms and auto language, preserves fillers in verbatim, and translates via the same endpoint', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ transcript: 'um hello' }));
    const transcriber = createSarvamTranscriber({ model: 'saaras:v3', mode: 'verbatim' }, 'secret');
    const input = request();
    input.recognition = { ...input.recognition, language: 'auto', removeFillerWords: true };
    expect(await transcriber.transcribe(input)).toBe('um hello');
    const body = fetchSpy.mock.calls[0]?.[1]?.body;
    if (!(body instanceof FormData)) throw new Error('Expected multipart upload');
    expect(body.has('language_code')).toBe(false);
    expect(body.has('keyterms')).toBe(false);
    await transcriber.transcribe({ ...input, recognition: { ...input.recognition, task: 'translate' } });
    const translationBody = fetchSpy.mock.calls[1]?.[1]?.body;
    if (!(translationBody instanceof FormData)) throw new Error('Expected multipart upload');
    expect(translationBody.get('mode')).toBe('translate');
  });

  it('rejects missing credentials and invalid language or excessive keyterms before uploading', async () => {
    fetchSpy = spyOn(globalThis, 'fetch');
    await expect(createSarvamTranscriber(DEFAULT_SARVAM_CONFIG, null).transcribe(request())).rejects.toMatchObject({ category: 'authentication' });
    const input = request();
    await expect(createSarvamTranscriber(DEFAULT_SARVAM_CONFIG, 'secret').transcribe({ ...input, recognition: { ...input.recognition, language: 'fr' } })).rejects.toThrow('supported Sarvam spoken language');
    expect(getSarvamSettingsErrors(DEFAULT_SARVAM_CONFIG, 'auto', Array.from({ length: 51 }, (_, i) => `term${i}`))).toHaveLength(1);
    expect(getSarvamSettingsErrors(DEFAULT_SARVAM_CONFIG, 'auto', ['x'.repeat(65)] )).toHaveLength(1);
    expect(getSarvamSettingsErrors(DEFAULT_SARVAM_CONFIG, 'auto', ['x'.repeat(64)] )).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([403, 429, 422, 503])('reports safe HTTP %s errors without echoing response bodies or credentials', async (status: number) => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('sensitive server body', { status }));
    await expect(createSarvamTranscriber(DEFAULT_SARVAM_CONFIG, 'secret').transcribe(request())).rejects.toMatchObject({ status });
  });

  it('rejects malformed JSON and missing transcripts and reports network errors', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{')).mockResolvedValueOnce(Response.json({ text: 'wrong field' })).mockRejectedValueOnce(new Error('secret'));
    const transcriber = createSarvamTranscriber(DEFAULT_SARVAM_CONFIG, 'secret');
    await expect(transcriber.transcribe(request())).rejects.toMatchObject({ category: 'malformed-response' });
    await expect(transcriber.transcribe(request())).rejects.toMatchObject({ category: 'malformed-response' });
    await expect(transcriber.transcribe(request())).rejects.toMatchObject({ category: 'network' });
  });
});
