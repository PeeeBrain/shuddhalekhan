import { z } from 'zod';

export const preferencesSchema = z.object({
  style: z.enum(['legacy', 'polished', 'casual', 'notes', 'verbatim']),
  vocabularyEnabled: z.boolean(),
  vocabulary: z.array(z.string()).max(100),
  sessionMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30)]),
  cleanupEnabled: z.boolean(),
});
export type DictationPreferences = z.infer<typeof preferencesSchema>;
export type DictationStyle = DictationPreferences['style'];
export type SessionMinutes = DictationPreferences['sessionMinutes'];
