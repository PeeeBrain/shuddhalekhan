import type { StreamingTranscriptSnapshot } from './transcription';

export type StreamingTranscriptUpdate =
  | { kind: 'accepted'; committed: string; tentative: string }
  | { kind: 'protocol-failure' };

export interface StreamingTranscriptLedger {
  apply(snapshot: StreamingTranscriptSnapshot): StreamingTranscriptUpdate;
  current(): { committed: string; tentative: string };
  finalize(): string;
}

export function createStreamingTranscriptLedger(): StreamingTranscriptLedger {
  let committed = '';
  let tentative = '';
  let lastSequence = -1;
  let failed = false;

  return {
    apply(snapshot) {
      if (
        failed
        || snapshot.sequence <= lastSequence
        || !snapshot.committed.startsWith(committed)
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
    finalize() {
      tentative = '';
      return committed;
    },
  };
}
