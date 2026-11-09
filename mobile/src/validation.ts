import { z } from 'zod';

export const googleServiceAccountSchema = z.object({
  type: z.literal('service_account'),
  client_email: z.email(),
  private_key: z.string().min(1).max(12000).refine(value => value.includes('-----BEGIN PRIVATE KEY-----')),
});

export function dictionaryTerms(dictionary: string): string[] {
  return [...new Set(dictionary.split(/[,\n]/).map(term => term.trim()).filter(Boolean))];
}

export function validateEndpoint(value: string, allowHTTP: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a full HTTPS endpoint URL.'); }
  if (url.username || url.password || url.hash) throw new Error('Endpoint URLs cannot contain credentials or fragments.');
  if (url.protocol !== 'https:' && !(allowHTTP && url.protocol === 'http:')) {
    throw new Error('Use HTTPS, or explicitly allow unencrypted HTTP in Settings.');
  }
  return url;
}
