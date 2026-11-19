import type { RecordingCue } from '@shuddhalekhan/shared/recording-cue';
import { requireOptionalNativeModule } from 'expo';
import { isParakeetLanguage, languageBase } from './languages';
import type { KeyboardSessionEvent } from './keyboard-session';

type Progress = { phase: 'downloading' | 'installing'; fraction: number };
type NativeSpeech = {
  initializeDictationPreferences?(existingInstall: boolean): Promise<void>;
  getDictationPreferences?(): Promise<unknown>;
  updateDictationPreferences?(patch: string): Promise<unknown>;
  getDictationReadiness?(): Promise<unknown>;
  requestDictationMicrophone?(): Promise<boolean>;
  setDictationModelLanguage?(language: string): Promise<void>;
  formatDictation?(text: string, snapshot: string, language: string): Promise<string>;
  consumeControlDictation?(): Promise<boolean>;
  consumeSystemDictation?(): Promise<string | null>;
  getModelState(language: string): Promise<'missing' | 'ready'>;
  prepareModel(language: string): Promise<void>;
  installModel(language: string): Promise<void>;
  transcribe(uri: string, language: string): Promise<string>;
  signGoogleJwt(privateKey: string, input: string): Promise<string>;
  getRecordingSounds?(): Promise<boolean>;
  setRecordingSounds?(enabled: boolean): Promise<void>;
  releaseForegroundRecording?(): Promise<void>;
  beginForegroundRecording?(): Promise<boolean>;
  getForegroundRecordingInterrupted?(): Promise<boolean>;
  playForegroundRecordingCue?(cue: RecordingCue): Promise<boolean>;
  cancelForegroundRecordingCue?(): Promise<boolean>;
  previewRecordingCue?(): Promise<void>;
  getKeyboardSession(): Promise<KeyboardSessionEvent>;
  startKeyboardSession(minutes: number, language: string, agentReady: boolean): Promise<KeyboardSessionEvent>;
  resolveKeyboardAgentRequest(id: string, error: string | null): Promise<void>;
  stopKeyboardSession(): Promise<void>;
  addListener(event: 'onForegroundRecordingInterrupted' | 'onControlDictation', listener: () => void): { remove(): void };
  addListener(event: 'onModelProgress', listener: (progress: Progress) => void): { remove(): void };
  addListener(event: 'onKeyboardSession', listener: (session: KeyboardSessionEvent) => void): { remove(): void };
};
export const speech = requireOptionalNativeModule<NativeSpeech>('ShuddhalekhanSpeech');

export function checkedLocalLanguage(language: string): string {
  if (!isParakeetLanguage(language)) throw new Error('Parakeet does not support this language. Choose a supported language or use an endpoint.');
  return languageBase(language);
}
