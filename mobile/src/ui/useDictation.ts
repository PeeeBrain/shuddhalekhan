import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';
import {
  getDictationPreferences, getDictationReadiness, requestDictationMicrophone, updateDictationPreferences,
  type DictationPreferences, type DictationReadiness,
} from '../dictation-preferences';

/**
 * Dictation preferences and keyboard readiness, read on mount and again whenever the app returns to the
 * foreground (the keyboard can change the style, and iOS Settings can change permissions, while we're away).
 * No polling: the only timer is the keyboard-verification expiry below, cleared on unmount.
 * Preferences live outside the Settings draft and apply immediately, like Recording Sounds.
 */
export function useDictation() {
  const [preferences, setPreferences] = useState<DictationPreferences | null>(null);
  const [readiness, setReadiness] = useState<DictationReadiness | null>(null);
  const expiry = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Keyboard and Full Access are only proven for a short window after the keyboard's last authenticated probe.
  // One timer per read flips them back to unverified at that deadline; a fresh read or unmount replaces it.
  const receiveReadiness = useCallback((next: DictationReadiness) => {
    clearTimeout(expiry.current);
    const remaining = next.keyboardVerifiedForMs;
    const unverified = { ...next, keyboard: 'unverified', fullAccess: 'unverified' } as const;
    if (remaining === undefined) return setReadiness(next);
    if (remaining <= 0) return setReadiness(unverified);
    setReadiness(next);
    expiry.current = setTimeout(() => setReadiness(unverified), remaining);
  }, []);

  const refresh = useCallback(() => {
    void getDictationPreferences().then(setPreferences, () => {});
    void getDictationReadiness().then(receiveReadiness, () => {});
  }, [receiveReadiness]);

  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener('change', next => { if (next === 'active') refresh(); });
    return () => { subscription.remove(); clearTimeout(expiry.current); };
  }, [refresh]);

  const update = async (patch: Partial<DictationPreferences>) => {
    try {
      setPreferences(await updateDictationPreferences(patch));
      return true;
    } catch (e) {
      Alert.alert('Not saved', e instanceof Error ? e.message : 'Could not save this dictation setting.');
      return false;
    }
  };

  // Only from an explicit tap; iOS shows its prompt once, after that the answer lives in iOS Settings.
  const requestMicrophone = async () => {
    await requestDictationMicrophone().catch(() => false);
    refresh();
  };

  return { preferences, readiness, update, refresh, requestMicrophone };
}
