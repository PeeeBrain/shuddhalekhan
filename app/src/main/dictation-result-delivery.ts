let latestDeliverableDictationSessionId: string | null = null;

export function markDictationResultPending(recordingSessionId: string): void {
  latestDeliverableDictationSessionId = recordingSessionId;
}

export function isDictationResultStillDeliverable(recordingSessionId: string): boolean {
  return latestDeliverableDictationSessionId === recordingSessionId;
}
