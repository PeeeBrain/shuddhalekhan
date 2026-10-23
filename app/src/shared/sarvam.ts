import { z } from 'zod';

export const SARVAM_MODELS = ['saaras:v4', 'saaras:v3'] as const;
export const SARVAM_MODES = ['transcribe', 'verbatim', 'translit', 'codemix'] as const;
export const sarvamConfigSchema = z.object({
  model: z.enum(SARVAM_MODELS),
  mode: z.enum(SARVAM_MODES),
});
export const DEFAULT_SARVAM_CONFIG = sarvamConfigSchema.parse({ model: 'saaras:v4', mode: 'transcribe' });

export const SARVAM_LANGUAGES = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'en-IN', label: 'English' },
  { value: 'hi-IN', label: 'Hindi' },
  { value: 'bn-IN', label: 'Bengali' },
  { value: 'kn-IN', label: 'Kannada' },
  { value: 'ml-IN', label: 'Malayalam' },
  { value: 'mr-IN', label: 'Marathi' },
  { value: 'od-IN', label: 'Odia' },
  { value: 'pa-IN', label: 'Punjabi' },
  { value: 'ta-IN', label: 'Tamil' },
  { value: 'te-IN', label: 'Telugu' },
  { value: 'gu-IN', label: 'Gujarati' },
  { value: 'as-IN', label: 'Assamese' },
  { value: 'ur-IN', label: 'Urdu' },
  { value: 'ne-IN', label: 'Nepali' },
  { value: 'kok-IN', label: 'Konkani' },
  { value: 'ks-IN', label: 'Kashmiri' },
  { value: 'sd-IN', label: 'Sindhi' },
  { value: 'sa-IN', label: 'Sanskrit' },
  { value: 'sat-IN', label: 'Santali' },
  { value: 'mni-IN', label: 'Manipuri' },
  { value: 'brx-IN', label: 'Bodo' },
  { value: 'mai-IN', label: 'Maithili' },
  { value: 'doi-IN', label: 'Dogri' },
];

export function sarvamLanguageCode(language: string): string | undefined {
  return SARVAM_LANGUAGES.find(({ value }) => value === language || value.split('-')[0] === language)?.value;
}

export function getSarvamSettingsErrors(config: z.infer<typeof sarvamConfigSchema>, language: string, dictionary: string[]): string[] {
  const errors: string[] = [];
  if (!sarvamConfigSchema.safeParse(config).success) errors.push('Select a supported Sarvam model and output mode.');
  if (!sarvamLanguageCode(language)) errors.push('Select a supported Sarvam spoken language or Auto-detect.');
  if (config.model === 'saaras:v4') {
    if (new Set(dictionary).size > 50) errors.push('Sarvam supports at most 50 distinct dictionary terms.');
    if (dictionary.some(term => [...term].length > 64)) errors.push('Sarvam dictionary terms must be 64 characters or fewer.');
  }
  return errors;
}
