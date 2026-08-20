import type { DictationFormatterProfile } from '../types/ipc';
import { classifyFormatterEndpoint, looksLikeRawApiKey } from '../shared/dictation-runtime';

type FormatterCredentialVault = {
  read(credential: 'dictation-formatter-api-key'): string | null;
};

export function getDictationFormatterApiKey(
  profile: DictationFormatterProfile,
  vault: FormatterCredentialVault,
): string | null {
  if (profile.apiKeySource === 'stored') {
    return vault.read('dictation-formatter-api-key');
  }

  if (classifyFormatterEndpoint(profile.baseUrl) === 'local') {
    return profile.apiKeyEnvVar && !looksLikeRawApiKey(profile.apiKeyEnvVar)
      ? process.env[profile.apiKeyEnvVar] ?? null
      : null;
  }

  if (!profile.apiKeyEnvVar) return null;
  if (looksLikeRawApiKey(profile.apiKeyEnvVar)) return null;
  return process.env[profile.apiKeyEnvVar] ?? null;
}
