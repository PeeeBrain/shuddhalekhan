import { z } from 'zod';
import { sarvamConfigSchema } from '../shared/sarvam';
import { managedLocalSelectionSchema } from '../shared/managed-local-selection';
import { hasDictionaryControlCharacters } from '../shared/transcription-features';

const text = z.string().max(2048);
const auth = z.enum(['none', 'bearer', 'header']);
const declaredCapabilities = {
  supportsAutomaticLanguageDetection: z.boolean(), supportsTranslation: z.boolean(), supportsDictionaryHints: z.boolean(),
};
const endpoint = { endpoint: text, model: text, auth, headerName: text };
const shortcut = z.object({
  binding: z.object({ keyCode: z.number().int().min(0).max(255).nullable(),
    modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'win'])).max(4) }).nullable(),
  activationMode: z.enum(['push-to-talk', 'toggle']),
});

/** Renderer edits may change recognition settings, never agent settings, file paths, or artifacts. */
export const transcriptionSettingsPatchSchema = z.object({
  transcription: z.object({
    activeProvider: z.enum(['managed-local', 'local-whisper-cpp', 'openai', 'sarvam', 'azure-speech',
      'google-cloud-speech-v2', 'nvidia-speech-nim', 'custom-open-ai-compatible', 'whisper-live-kit']),
    providers: z.object({
      localWhisperCpp: z.object({ endpoint: text }),
      openai: z.object({ baseUrl: text, model: text }),
      sarvam: sarvamConfigSchema,
      azureSpeech: z.object({ endpoint: text, region: text }),
      googleCloudSpeech: z.object({ project: text, location: text, model: text,
        credentialSource: z.enum(['service-account', 'adc']) }),
      nvidiaSpeechNim: z.object({ ...endpoint, ...declaredCapabilities }),
      customOpenAiCompatible: z.object({ ...endpoint,
        supportsAutomaticLanguageDetection: z.boolean().optional(), supportsTranslation: z.boolean().optional(),
        supportsDictionaryHints: z.boolean().optional() }),
      whisperLiveKit: z.object({ baseUrl: text, auth: z.enum(['none', 'bearer']) }),
    }),
  }).optional(),
  managedLocal: managedLocalSelectionSchema.optional(),
  language: z.string().min(1).max(64).optional(),
  task: z.enum(['transcribe', 'translate']).optional(),
  dictionary: z.array(z.string().min(1).max(512).refine(term => !hasDictionaryControlCharacters(term),
    'Dictionary terms cannot contain control characters.')).max(1000).optional(),
  removeFillerWords: z.boolean().optional(),
  dictation: z.object({ mode: z.enum(['batch', 'live', 'corrected']), formatter: z.object({
    baseUrl: text, model: text, apiKeyEnvVar: text, apiKeySource: z.enum(['stored', 'environment']).default('environment'),
    processingConsent: z.boolean(),
  }).nullable() }).optional(),
  shortcuts: z.object({ dictation: shortcut, agent: shortcut }).optional(),
}).strict();
