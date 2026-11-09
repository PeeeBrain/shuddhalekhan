/** Settings fields stored in SecureStore rather than the public settings envelope. */
export const secretFields = [
  { field: 'transcriptionKey', ref: 'transcriptionKeyRef', key: 'transcription', scope: 'transcription', legacyOptional: false },
  { field: 'agentKey', ref: 'agentKeyRef', key: 'agent', scope: 'agent', legacyOptional: false },
  { field: 'googleServiceAccount', ref: 'googleServiceAccountRef', key: 'google', scope: 'transcription', legacyOptional: true },
] as const;

export function clearedSecrets(scope: typeof secretFields[number]['scope']) {
  return Object.fromEntries(secretFields.filter(secret => secret.scope === scope).map(secret => [secret.field, '']));
}
