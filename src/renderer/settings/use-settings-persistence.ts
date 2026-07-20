import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppConfig } from '../../types/ipc';
import type { SettingsIpc } from './settings-ipc';

export type FieldErrors = Record<string, string>;

export interface SaveToastState {
  message: string;
  tone: 'success' | 'error';
  key: number;
}

export interface SettingsPersistence {
  commit: <K extends keyof AppConfig>(
    key: K,
    value: AppConfig[K],
    fieldId: string,
  ) => Promise<void>;
  fieldErrors: FieldErrors;
  clearFieldError: (fieldId: string) => void;
  toast: SaveToastState | null;
}

export const SAVE_TOAST_DURATION_MS = 2500;
const SAVE_TOAST_MESSAGE = 'Settings saved';

export function useSettingsPersistence(
  settingsIpc: SettingsIpc,
  applyOptimistic: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void,
): SettingsPersistence {
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [toast, setToast] = useState<SaveToastState | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissToast = useCallback((key: number) => {
    setToast((current) => (current && current.key === key ? null : current));
  }, []);

  const showToast = useCallback(
    (tone: SaveToastState['tone'], message: string) => {
      const key = Date.now();
      setToast({ message, tone, key });
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => {
        dismissToast(key);
      }, SAVE_TOAST_DURATION_MS);
    },
    [dismissToast],
  );

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const clearFieldError = useCallback((fieldId: string) => {
    setFieldErrors((current) => {
      if (!current[fieldId]) return current;
      const next = { ...current };
      delete next[fieldId];
      return next;
    });
  }, []);

  const commit = useCallback(
    async <K extends keyof AppConfig>(
      key: K,
      value: AppConfig[K],
      fieldId: string,
    ) => {
      applyOptimistic(key, value);
      try {
        await settingsIpc.setConfig(key, value);
        clearFieldError(fieldId);
        showToast('success', SAVE_TOAST_MESSAGE);
      } catch {
        setFieldErrors((current) => ({
          ...current,
          [fieldId]: 'Could not save this setting.',
        }));
      }
    },
    [applyOptimistic, clearFieldError, showToast, settingsIpc],
  );

  return { commit, fieldErrors, clearFieldError, toast };
}