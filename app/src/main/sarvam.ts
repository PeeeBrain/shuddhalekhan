import { z } from 'zod';
import type { TranscriptionConfig } from '../types/ipc';
import { getSarvamSettingsErrors, sarvamLanguageCode } from '../shared/sarvam';
import { cleanFillerWords, failureForHttpStatus, TranscriptionFailure, type Transcriber } from './transcription';

const responseSchema = z.object({ transcript: z.string() });

export function createSarvamTranscriber(
  config: TranscriptionConfig['providers']['sarvam'],
  apiKey: string | null,
): Transcriber {
  return {
    id: 'sarvam',
    capabilities: {
      translation: true,
      automaticLanguageDetection: true,
      dictionaryHints: config.model === 'saaras:v4',
      authentication: 'required',
      maxDurationSeconds: 30,
    },
    async transcribe({ audio, recognition }) {
      if (!apiKey) throw new TranscriptionFailure('authentication', 'Sarvam API key is not configured. Save one in Settings.');
      const errors = getSarvamSettingsErrors(config, recognition.language, recognition.dictionary);
      if (errors.length) throw new TranscriptionFailure('model', errors.join(' '));

      const mode = recognition.task === 'translate' ? 'translate' : config.mode;
      const form = new FormData();
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');
      form.append('model', config.model);
      form.append('mode', mode);
      const language = sarvamLanguageCode(recognition.language);
      if (language && language !== 'auto') form.append('language_code', language);
      if (config.model === 'saaras:v4' && recognition.dictionary.length) {
        form.append('keyterms', JSON.stringify([...new Set(recognition.dictionary)]));
      }

      let response: Response;
      try {
        response = await fetch('https://api.sarvam.ai/speech-to-text', {
          method: 'POST',
          headers: { 'api-subscription-key': apiKey },
          body: form,
        });
      } catch {
        throw new TranscriptionFailure('network', 'Could not reach Sarvam. Check your network connection.');
      }
      if (!response.ok) throw failureForHttpStatus(response.status, 'Sarvam');

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new TranscriptionFailure('malformed-response', 'Sarvam returned an invalid response.');
      }
      const parsed = responseSchema.safeParse(data);
      if (!parsed.success) throw new TranscriptionFailure('malformed-response', 'Sarvam returned an invalid response.');
      const text = parsed.data.transcript.trim();
      return recognition.removeFillerWords && mode !== 'verbatim' ? cleanFillerWords(text) : text;
    },
  };
}
