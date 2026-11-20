import { z } from 'zod';
import { speech } from './native-speech';
import { preferencesSchema, type DictationPreferences } from './dictation-preference-schema';

export type { DictationPreferences, DictationStyle, SessionMinutes } from './dictation-preference-schema';

const readinessSchema = z.object({
  keyboard: z.enum(['verified', 'unverified']),
  fullAccess: z.enum(['verified', 'unverified']),
  keyboardVerifiedForMs: z.coerce.number().int().min(0).max(10_000).optional(),
  microphone: z.enum(['granted', 'denied', 'undetermined']),
  cleanup: z.enum(['available', 'unavailable']),
  cleanupReason: z.string().optional(),
});
export type DictationReadiness = z.infer<typeof readinessSchema>;

const legacyPreferences: DictationPreferences = {
  style: 'legacy', vocabularyEnabled: false, vocabulary: [], sessionMinutes: 10, cleanupEnabled: false,
};

export async function getDictationPreferences(): Promise<DictationPreferences> {
  if (!speech?.getDictationPreferences) return legacyPreferences;
  return preferencesSchema.parse(await speech.getDictationPreferences());
}

export async function updateDictationPreferences(patch: Partial<DictationPreferences>): Promise<DictationPreferences> {
  if (!speech?.updateDictationPreferences) throw new Error('Dictation settings require the latest iOS build.');
  return preferencesSchema.parse(await speech.updateDictationPreferences(JSON.stringify(patch)));
}

export async function getDictationReadiness(): Promise<DictationReadiness> {
  if (!speech?.getDictationReadiness) {
    return { keyboard: 'unverified', fullAccess: 'unverified', microphone: 'undetermined',
      cleanup: 'unavailable', cleanupReason: 'Install the latest iOS build.' };
  }
  return readinessSchema.parse(await speech.getDictationReadiness());
}

export async function requestDictationMicrophone(): Promise<boolean> {
  return await speech?.requestDictationMicrophone?.() ?? false;
}
