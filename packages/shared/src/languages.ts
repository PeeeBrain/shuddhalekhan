export const LANGUAGE_LOCALES: Record<string, string> = {
  bg: 'bg-BG', hr: 'hr-HR', cs: 'cs-CZ', da: 'da-DK', nl: 'nl-NL', en: 'en-US',
  et: 'et-EE', fi: 'fi-FI', fr: 'fr-FR', de: 'de-DE', el: 'el-GR', hu: 'hu-HU',
  it: 'it-IT', lv: 'lv-LV', lt: 'lt-LT', mt: 'mt-MT', pl: 'pl-PL', pt: 'pt-BR',
  ro: 'ro-RO', ru: 'ru-RU', sk: 'sk-SK', sl: 'sl-SI', es: 'es-ES', sv: 'sv-SE', uk: 'uk-UA',
  hi: 'hi-IN', mr: 'mr-IN', gu: 'gu-IN', bn: 'bn-IN', ta: 'ta-IN', te: 'te-IN',
  kn: 'kn-IN', ml: 'ml-IN', pa: 'pa-IN', ur: 'ur-IN', ne: 'ne-NP', as: 'as-IN',
  // Sarvam's Odia code is `od`; BCP 47 providers use `or`.
  od: 'or-IN',
  ar: 'ar-SA', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR',
};

// Desktop providers historically map only this subset; unknown codes pass through.
export const DESKTOP_LANGUAGE_LOCALES: Record<string, string> = Object.fromEntries(
  ['en', 'hi', 'mr', 'gu', 'bn', 'ta', 'te', 'kn', 'ml', 'pa', 'ur', 'fr', 'es', 'de', 'ja', 'zh', 'ko', 'pt', 'ar', 'ru']
    .map(language => [language, LANGUAGE_LOCALES[language]!]),
);

export function nimLocale(language: string, locale = language): string {
  return language === 'es' ? 'es-US' : locale;
}
