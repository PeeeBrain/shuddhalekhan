export const WHISPER_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi (हिन्दी)' },
  { value: 'mr', label: 'Marathi (मराठी)' },
  { value: 'gu', label: 'Gujarati (ગુજરાતી)' },
  { value: 'bn', label: 'Bengali (বাংলা)' },
  { value: 'ta', label: 'Tamil (தமிழ்)' },
  { value: 'te', label: 'Telugu (తెలుగు)' },
  { value: 'kn', label: 'Kannada (ಕನ್ನಡ)' },
  { value: 'ml', label: 'Malayalam (മലയാളം)' },
  { value: 'pa', label: 'Punjabi (ਪੰਜਾਬੀ)' },
  { value: 'ur', label: 'Urdu (اردو)' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'de', label: 'German' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ko', label: 'Korean' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ar', label: 'Arabic' },
  { value: 'ru', label: 'Russian' },
];

export function isLocalProviderUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return ['localhost', '127.0.0.1', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

export function looksLikeRawApiKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_-]/.test(value.trim());
}