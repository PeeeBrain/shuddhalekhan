import type { DictationTargetSnapshot } from '../types/ipc';

export type LastTranscriptInjectionStatus =
  | 'pending'
  | 'dispatched'
  | 'failed'
  | 'uncertain';

export interface LastTranscript {
  text: string;
  createdAt: string;
  injectionStatus: LastTranscriptInjectionStatus;
  targetSnapshot: DictationTargetSnapshot | null;
  liveDispatch?: {
    hasAcceptedEvents: boolean;
    uncertain: boolean;
  };
}

let lastTranscript: LastTranscript | null = null;

export function setLastTranscript(
  text: string,
  targetSnapshot: DictationTargetSnapshot | null = null,
  liveDispatch?: LastTranscript['liveDispatch'],
): void {
  if (!text) return;
  lastTranscript = {
    text,
    createdAt: new Date().toISOString(),
    injectionStatus: 'pending',
    targetSnapshot,
    ...(liveDispatch ? { liveDispatch } : {}),
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

export function clearLastTranscript(): void {
  lastTranscript = null;
}
