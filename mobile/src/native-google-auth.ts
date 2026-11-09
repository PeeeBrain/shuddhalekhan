import { speech } from './native-speech';

export async function signGoogleJwt(privateKey: string, input: string): Promise<string> {
  if (!speech) throw new Error('Google service-account authentication requires the updated native app build.');
  try { return await speech.signGoogleJwt(privateKey, input); }
  catch { throw new Error('Could not sign with this Google service-account key. Check its private key.'); }
}
