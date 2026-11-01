import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppConfig, TranscriptionSettingsPatch } from '../../types/ipc';
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
  /**
   * Saves a dependent transcription change in one main-validated step and resolves
   * main's canonical config. Resolves null after restoring the saved config, so
   * callers must stop on null.
   */
  commitTranscription: (patch: TranscriptionSettingsPatch, fieldId: string) => Promise<AppConfig | null>;
  fieldErrors: FieldErrors;
  clearFieldError: (fieldId: string) => void;
  toast: SaveToastState | null;
}

/** Only the keys a transition owns, so unrelated in-flight edits are not clobbered. */
function transcriptionSlice(config: AppConfig): TranscriptionSettingsPatch {
  const { transcription, managedLocal, language, task, dictionary, removeFillerWords, dictation, shortcuts } = config;
  return { transcription, managedLocal, language, task, dictionary, removeFillerWords, dictation, shortcuts };
}

export const SAVE_TOAST_DURATION_MS = 2500;
const SAVE_TOAST_MESSAGE = 'Settings saved';
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+': (?:\w*Error: )?/;

/** Main's validation errors arrive wrapped by Electron; anything else gets the generic fallback. */
export function ipcErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && IPC_ERROR_PREFIX.test(error.message)
    ? error.message.replace(IPC_ERROR_PREFIX, '') || fallback
    : fallback;
}

export function useSettingsPersistence(
  settingsIpc: SettingsIpc,
  /** Merges into the rendered config; must not replace keys outside `patch`. */
  applyConfig: (patch: Partial<AppConfig>) => void,
): SettingsPersistence {
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [toast, setToast] = useState<SaveToastState | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptionRevision = useRef(0);

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
      applyConfig({ [key]: value });
      try {
        await settingsIpc.setConfig(key, value);
        clearFieldError(fieldId);
        showToast('success', SAVE_TOAST_MESSAGE);
      } catch (error) {
        setFieldErrors((current) => ({
          ...current,
          [fieldId]: ipcErrorMessage(error, 'Could not save this setting.'),
        }));
        await settingsIpc.getConfig().then(saved => applyConfig({ [key]: saved[key] })).catch(() => undefined);
      }
    },
    [applyConfig, clearFieldError, showToast, settingsIpc],
  );

  const commitTranscription = useCallback(
    async (patch: TranscriptionSettingsPatch, fieldId: string) => {
      const revision = ++transcriptionRevision.current;
      applyConfig(patch);
      try {
        const saved = await settingsIpc.patchTranscriptionConfig(patch);
        // A newer transition owns the rendered state; its own reply will land.
        if (revision === transcriptionRevision.current) applyConfig(transcriptionSlice(saved));
        clearFieldError(fieldId);
        showToast('success', SAVE_TOAST_MESSAGE);
        return saved;
      } catch (error) {
        setFieldErrors((current) => ({
          ...current,
          [fieldId]: ipcErrorMessage(error, 'Could not save this setting.'),
        }));
        if (revision === transcriptionRevision.current) {
          await settingsIpc.getConfig()
            .then((saved) => {
              if (revision === transcriptionRevision.current) applyConfig(transcriptionSlice(saved));
            })
            .catch(() => undefined);
        }
        return null;
      }
    },
    [applyConfig, clearFieldError, showToast, settingsIpc],
  );

  return { commit, commitTranscription, fieldErrors, clearFieldError, toast };
}
