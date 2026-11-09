import type { Transcriber } from './transcription';
import { transcribeOpenAiLike } from './transcription';

export function createLocalWhisperCppTranscriber(endpoint: string): Transcriber {
  return {
    id: 'local-whisper-cpp',
    capabilities: { maxDurationSeconds: null },
    transcribe: ({ audio, recognition, signal }) => transcribeOpenAiLike(
      audio, recognition, endpoint, undefined, 'none', undefined, undefined, 'whisper-cpp', signal,
    ),
  };
}
