import type { AppConfig, TranscriptionSettingsPatch } from '../types/ipc';
import { getTranscriptionTransportCapabilities } from './dictation-runtime';
import { SARVAM_LANGUAGES, sarvamLanguageCode } from './sarvam';

type FeatureConfig = Pick<AppConfig, 'transcription' | 'managedLocal' | 'dictation' | 'task'>;

export function hasDictionaryControlCharacters(term: string): boolean {
  return [...term].some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function resolveTranscriptionFeatures(config: FeatureConfig, localLanguages?: readonly string[]) {
  const provider = config.transcription.activeProvider;
  const providers = config.transcription.providers;
  const language: { kind: 'fixed'; value: 'en' | 'auto' } | { kind: 'select'; codes: readonly string[] | null } =
    provider === 'managed-local'
      ? { kind: 'fixed', value: localLanguages && localLanguages.length > 1 ? 'auto' : 'en' }
      : { kind: 'select', codes: provider === 'sarvam' ? SARVAM_LANGUAGES.map(item => item.value) : null };
  let translation = false;
  let automaticLanguageDetection = language.kind !== 'fixed' || language.value === 'auto';
  let dictionaryHints = true;
  let dictionaryMaxTerms: number | null = null;
  let dictionaryMaxTermLength: number | null = null;
  switch (provider) {
    case 'managed-local':
      dictionaryHints = (config.managedLocal?.model ?? 'parakeet') === 'parakeet';
      dictionaryMaxTerms = 64;
      dictionaryMaxTermLength = 128;
      break;
    case 'local-whisper-cpp':
      translation = true;
      break;
    case 'openai': {
      const model = providers.openai.model.trim();
      translation = model === 'whisper-1';
      dictionaryHints = model === 'whisper-1' || /^(?:gpt-4o(?:-mini)?-transcribe|gpt-transcribe)(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
      break;
    }
    case 'sarvam':
      translation = true;
      dictionaryHints = providers.sarvam.model === 'saaras:v4';
      dictionaryMaxTerms = 50;
      dictionaryMaxTermLength = 64;
      break;
    case 'google-cloud-speech-v2':
      automaticLanguageDetection = false;
      break;
    case 'nvidia-speech-nim':
      translation = providers.nvidiaSpeechNim.supportsTranslation;
      automaticLanguageDetection = providers.nvidiaSpeechNim.supportsAutomaticLanguageDetection;
      dictionaryHints = providers.nvidiaSpeechNim.supportsDictionaryHints;
      break;
    case 'custom-open-ai-compatible':
      // Missing declarations preserve the contract of previously saved custom endpoints.
      translation = providers.customOpenAiCompatible.supportsTranslation ?? true;
      automaticLanguageDetection = providers.customOpenAiCompatible.supportsAutomaticLanguageDetection ?? true;
      dictionaryHints = providers.customOpenAiCompatible.supportsDictionaryHints ?? true;
      break;
    case 'whisper-live-kit':
      dictionaryHints = false;
      break;
    case 'azure-speech':
      break;
  }
  return {
    ...getTranscriptionTransportCapabilities(provider),
    translation, automaticLanguageDetection, dictionaryHints, language,
    cleanup: config.dictation.mode !== 'live'
      && !(provider === 'sarvam' && config.task === 'transcribe' && providers.sarvam.mode === 'verbatim'),
    dictionaryMaxTerms, dictionaryMaxTermLength,
  };
}

/** Only active recognition options cross the provider boundary; saved vocabulary remains intact. */
export function resolveRecognitionSettings(config: AppConfig, localLanguages?: readonly string[]) {
  const features = resolveTranscriptionFeatures(config, localLanguages);
  const incompatibleLocalVocabulary = config.transcription.activeProvider === 'managed-local'
    && getTranscriptionDictionaryError(config) !== null;
  return {
    language: features.language.kind === 'fixed' ? features.language.value : config.language,
    task: config.task,
    dictionary: features.dictionaryHints && !incompatibleLocalVocabulary ? [...new Set(config.dictionary)] : [],
    removeFillerWords: features.cleanup && config.removeFillerWords,
  };
}

/** Normalize dependent choices only for an explicit settings transition, never on startup. */
export function normalizeTranscriptionTransition(config: AppConfig, patch: TranscriptionSettingsPatch): AppConfig {
  const next = { ...config, ...patch };
  const features = resolveTranscriptionFeatures(next);
  if (!features.streaming && next.dictation.mode === 'live') next.dictation = { ...next.dictation, mode: 'batch' };
  if (!features.translation) next.task = 'transcribe';
  // Local models ignore language hints; keep the saved preference for providers that accept them.
  if (features.language.kind === 'select') {
    if (next.transcription.activeProvider === 'sarvam' && !sarvamLanguageCode(next.language)) next.language = 'auto';
    else if (!features.automaticLanguageDetection && next.language === 'auto') next.language = 'en';
  }
  return next;
}

export function getTranscriptionDictionaryError(config: FeatureConfig & Pick<AppConfig, 'dictionary'>): string | null {
  const features = resolveTranscriptionFeatures(config);
  if (!features.dictionaryHints) return null;
  if (features.dictionaryMaxTerms !== null && new Set(config.dictionary).size > features.dictionaryMaxTerms) {
    return `This model supports at most ${features.dictionaryMaxTerms} distinct dictionary terms.`;
  }
  const maxLength = features.dictionaryMaxTermLength;
  if (maxLength !== null && config.dictionary.some(term => [...term].length > maxLength)) {
    return `Dictionary terms must be ${maxLength} characters or fewer for this model.`;
  }
  if (config.dictionary.some(term => !term.trim() || hasDictionaryControlCharacters(term))) {
    return 'Dictionary terms must contain text without control characters.';
  }
  if (config.transcription.activeProvider === 'managed-local' && config.dictionary.some(term => /[/:]/u.test(term))) {
    return 'Local vocabulary terms cannot contain slashes or colons.';
  }
  return null;
}
