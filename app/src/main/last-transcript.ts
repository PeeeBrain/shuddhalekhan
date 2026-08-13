import type { DictationTargetSnapshot } from '../types/ipc';

export interface LastTranscript {
  text: string;
  createdAt: string;
  injectionStatus: 'pending' | 'dispatched' | 'failed';
  targetSnapshot: DictationTargetSnapshot | null;
}

let lastTranscript: LastTranscript | null = null;

export function setLastTranscript(text: string, targetSnapshot: DictationTargetSnapshot | null = null): void {
  if (!text) return;
  lastTranscript = {
    text,
    createdAt: new Date().toISOString(),
    injectionStatus: 'pending',
    targetSnapshot,
  };
}

export function getLastTranscript(): LastTranscript | null {
  return lastTranscript;
}

export function markLastTranscriptInjected(status: 'dispatched' | 'failed'): void {
  if (lastTranscript) {
    lastTranscript.injectionStatus = status;
  }
}

export function clearLastTranscript(): void {
  lastTranscript = null;
}
