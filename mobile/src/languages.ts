import { LANGUAGE_LOCALES } from '@shuddhalekhan/shared/languages';
import { SARVAM_LANGUAGES } from '@shuddhalekhan/shared/sarvam';

/** Parakeet v3's 25 languages. English alone routes to the English-only v2 model. */
export const parakeetLanguages = [
  { value: 'bg', label: 'Bulgarian' }, { value: 'hr', label: 'Croatian' },
  { value: 'cs', label: 'Czech' }, { value: 'da', label: 'Danish' },
  { value: 'nl', label: 'Dutch' }, { value: 'en', label: 'English' },
  { value: 'et', label: 'Estonian' }, { value: 'fi', label: 'Finnish' },
  { value: 'fr', label: 'French' }, { value: 'de', label: 'German' },
  { value: 'el', label: 'Greek' }, { value: 'hu', label: 'Hungarian' },
  { value: 'it', label: 'Italian' }, { value: 'lv', label: 'Latvian' },
  { value: 'lt', label: 'Lithuanian' }, { value: 'mt', label: 'Maltese' },
  { value: 'pl', label: 'Polish' }, { value: 'pt', label: 'Portuguese' },
  { value: 'ro', label: 'Romanian' }, { value: 'ru', label: 'Russian' },
  { value: 'sk', label: 'Slovak' }, { value: 'sl', label: 'Slovenian' },
  { value: 'es', label: 'Spanish' }, { value: 'sv', label: 'Swedish' },
  { value: 'uk', label: 'Ukrainian' },
];

export const speechLanguages = [
  ...parakeetLanguages,
  // Remote providers use the region for accent-specific recognition; Parakeet uses only the base language.
  { value: 'en-IN', label: 'English (India)' }, { value: 'en-GB', label: 'English (UK)' }, { value: 'en-US', label: 'English (US)' },
  ...SARVAM_LANGUAGES.filter(({ value }) => value !== 'auto' && !parakeetLanguages.some(language => language.value === value.split('-')[0]))
    .map(({ value, label }) => ({ value: value.split('-')[0]!, label })),
  { value: 'ar', label: 'Arabic' }, { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' }, { value: 'ko', label: 'Korean' },
].sort((a, b) => a.label.localeCompare(b.label));

/** Canonical BCP 47 casing (`en-in` → `en-IN`). Upgrades the old free-text field, including names. */
export function normalizeLanguage(value: string): string {
  const language = value.trim();
  if (!language || /^auto(-detect)?$/i.test(language)) return '';
  const named = speechLanguages.find(option => option.label.toLowerCase() === language.toLowerCase());
  if (named) return named.value;
  return language.replace(/_/g, '-').split('-').map((part, index) => index === 0 ? part.toLowerCase()
    : part.length === 2 ? part.toUpperCase() : part.length === 4 ? part[0]!.toUpperCase() + part.slice(1).toLowerCase() : part.toLowerCase()).join('-');
}

export function languageBase(language: string): string {
  return normalizeLanguage(language).split('-')[0] ?? '';
}

export function languageLabel(language: string): string {
  const normalized = normalizeLanguage(language);
  if (!normalized) return 'Auto-detect';
  return speechLanguages.find(option => option.value === normalized)?.label ?? normalized;
}

export function isParakeetLanguage(language: string): boolean {
  const base = languageBase(language);
  return !base || parakeetLanguages.some(option => option.value === base);
}


/** Locale for providers that require one (Azure, Google, NVIDIA NIM). An explicit region wins. */
export function languageLocale(language: string): string {
  const normalized = normalizeLanguage(language);
  return normalized.includes('-') ? normalized : LANGUAGE_LOCALES[normalized] ?? normalized;
}
