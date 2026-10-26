import { z } from 'zod';
import { bearerHeaders, parseResponse, readJSON, request, type Fetch } from './network';
import type { MobileSettings } from './settings';

export async function transcribe({ audio, settings, signal, fetch }: {
  audio: Blob;
  settings: MobileSettings;
  signal: AbortSignal;
  fetch: Fetch;
}): Promise<string> {
  const form = new FormData();
  form.append('file', audio, 'recording.wav');
  if (settings.transcriptionModel) form.append('model', settings.transcriptionModel);
  form.append('response_format', 'json');
  if (settings.language) form.append('language', settings.language);
  if (settings.dictionary.trim()) form.append('prompt', settings.dictionary.trim());
  const data = await request({ fetch, endpoint: settings.transcriptionEndpoint, allowHTTP: settings.allowInsecureHTTP, signal,
    init: { method: 'POST', headers: bearerHeaders(settings.transcriptionKey), body: form }, read: readJSON });
  const { text } = parseResponse(z.object({ text: z.string().max(200_000) }), data);
  if (!text.trim()) throw new Error('No speech was recognized. Record again.');
  return text.trim();
}
