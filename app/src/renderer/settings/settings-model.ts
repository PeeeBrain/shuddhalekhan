import type { TranscriptionProviderId } from '../../types/ipc';

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
  { value: 'ne', label: 'Nepali' },
  { value: 'sd', label: 'Sindhi' },
  { value: 'sa', label: 'Sanskrit' },
  { value: 'as', label: 'Assamese' },
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

export { isLoopbackUrl as isLocalProviderUrl } from '@shuddhalekhan/shared/validation';

export function looksLikeRawApiKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_-]/.test(value.trim());
}

interface ProviderOption {
  value: TranscriptionProviderId;
  label: string;
  description: string;
}

export const PROVIDER_GROUPS: Array<{ label: 'Local' | 'Cloud' | 'Custom'; options: ProviderOption[] }> = [
  {
    label: 'Local',
    options: [
      { value: 'managed-local', label: 'Managed Local', description: 'Private local speech recognition managed by Shuddhalekhan.' },
      { value: 'local-whisper-cpp', label: 'Local whisper.cpp', description: 'Private whisper.cpp-compatible inference endpoint.' },
    ],
  },
  {
    label: 'Cloud',
    options: [
      { value: 'openai', label: 'OpenAI', description: 'OpenAI batch audio transcription.' },
      { value: 'sarvam', label: 'Sarvam AI', description: 'Saaras speech-to-text for Indian languages and English.' },
      { value: 'azure-speech', label: 'Microsoft Azure Speech', description: 'Azure Speech Fast Transcription.' },
      { value: 'google-cloud-speech-v2', label: 'Google Cloud Speech-to-Text v2', description: 'Google synchronous Speech-to-Text v2.' },
    ],
  },
  {
    label: 'Custom',
    options: [
      { value: 'nvidia-speech-nim', label: 'NVIDIA Speech NIM', description: 'Self-hosted NVIDIA offline transcription.' },
      { value: 'custom-open-ai-compatible', label: 'Custom OpenAI-compatible', description: 'A compatible private or local audio endpoint.' },
      { value: 'whisper-live-kit', label: 'WhisperLiveKit', description: 'Self-hosted Dictation with live previews, health and protocol readiness checks.' },
    ],
  },
];

export const PROVIDER_OPTIONS = PROVIDER_GROUPS.flatMap((group) => group.options);

export function transcriptionProviderLabel(id: TranscriptionProviderId): string {
  return PROVIDER_OPTIONS.find((option) => option.value === id)?.label ?? id;
}
