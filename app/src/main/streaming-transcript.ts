import type { StreamingTranscriptSnapshot } from './transcription';

export type StreamingTranscriptUpdate =
  | { kind: 'accepted'; committed: string; tentative: string }
  | { kind: 'protocol-failure' };

export interface StreamingTranscriptLedger {
  apply(snapshot: StreamingTranscriptSnapshot): StreamingTranscriptUpdate;
  current(): { committed: string; tentative: string };
}

/**
 * Tracks the latest preview snapshot. Providers may revise earlier recognition,
 * so each snapshot replaces the last; only ordering and shape are enforced.
 * Previews are never the final transcript: the provider's finish() is.
 */
export function createStreamingTranscriptLedger(): StreamingTranscriptLedger {
  let committed = '';
  let tentative = '';
  let lastSequence = -1;
  let failed = false;

  return {
    apply(snapshot) {
      if (
        failed
        || !Number.isSafeInteger(snapshot.sequence)
        || snapshot.sequence <= lastSequence
        || typeof snapshot.committed !== 'string'
        || typeof snapshot.tentative !== 'string'
        || !snapshot.tentative.startsWith(snapshot.committed)
      ) {
        failed = true;
        return { kind: 'protocol-failure' };
      }
      lastSequence = snapshot.sequence;
      committed = snapshot.committed;
      tentative = snapshot.tentative;
      return { kind: 'accepted', committed, tentative };
    },
    current() {
      return { committed, tentative };
    },
  };
}
