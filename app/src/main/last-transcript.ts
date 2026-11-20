import type { DictationTargetSnapshot } from '../types/ipc';

export type LastTranscriptInjectionStatus =
  | 'pending'
  | 'dispatched'
  | 'failed'
  | 'uncertain';

export interface LastTranscript {
  text: string;
  /** The transcript before Corrected Dictation formatting, when formatting changed it. */
  rawText: string | null;
  createdAt: string;
  injectionStatus: LastTranscriptInjectionStatus;
  targetSnapshot: DictationTargetSnapshot | null;
  /** Unset until delivery first settles; null when History was off then. */
  historyId?: number | null;
}

let lastTranscript: LastTranscript | null = null;

export function setLastTranscript(
  text: string,
  targetSnapshot: DictationTargetSnapshot | null = null,
  rawText: string | null = null,
): void {
  if (!text) return;
  lastTranscript = {
    text,
    rawText: rawText && rawText !== text ? rawText : null,
    createdAt: new Date().toISOString(),
    injectionStatus: 'pending',
    targetSnapshot,
  };
}

export function getLastTranscript(): LastTranscript | null {
  return lastTranscript;
}

export function markLastTranscriptInjected(
  status: Exclude<LastTranscriptInjectionStatus, 'pending'>,
): void {
  if (lastTranscript) {
    lastTranscript.injectionStatus = status;
  }
}
