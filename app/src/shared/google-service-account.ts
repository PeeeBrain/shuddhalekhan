export interface GoogleServiceAccount {
  type: 'service_account';
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id?: string;
}

export function parseGoogleServiceAccount(value: string): GoogleServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Select a valid Google service-account JSON document.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Select a valid Google service-account JSON document.');
  const candidate = parsed as Partial<GoogleServiceAccount>;
  if (candidate.type !== 'service_account' || !candidate.client_email?.trim()
    || !candidate.private_key?.includes('BEGIN PRIVATE KEY') || !candidate.token_uri?.startsWith('https://')) {
    throw new Error('The document must contain a service-account type, client_email, private_key, and HTTPS token_uri.');
  }
  return candidate as GoogleServiceAccount;
}
