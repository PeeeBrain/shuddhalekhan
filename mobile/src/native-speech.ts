import { requireOptionalNativeModule } from 'expo';
import { isParakeetLanguage, languageBase } from './languages';
import type { KeyboardSessionEvent } from './keyboard-session';

type Progress = { phase: 'downloading' | 'installing'; fraction: number };
type NativeSpeech = {
  getModelState(language: string): Promise<'missing' | 'ready'>;
  prepareModel(language: string): Promise<void>;
  installModel(language: string): Promise<void>;
  transcribe(uri: string, language: string): Promise<string>;
  signGoogleJwt(privateKey: string, input: string): Promise<string>;
  getKeyboardSession(): Promise<KeyboardSessionEvent>;
  startKeyboardSession(minutes: number, language: string, agentReady: boolean): Promise<KeyboardSessionEvent>;
  resolveKeyboardAgentRequest(id: string, error: string | null): Promise<void>;
  stopKeyboardSession(): Promise<void>;
  addListener(event: 'onModelProgress', listener: (progress: Progress) => void): { remove(): void };
  addListener(event: 'onKeyboardSession', listener: (session: KeyboardSessionEvent) => void): { remove(): void };
};
export const speech = requireOptionalNativeModule<NativeSpeech>('ShuddhalekhanSpeech');

export function checkedLocalLanguage(language: string): string {
  if (!isParakeetLanguage(language)) throw new Error('Parakeet does not support this language. Choose a supported language or use an endpoint.');
  return languageBase(language);
}
