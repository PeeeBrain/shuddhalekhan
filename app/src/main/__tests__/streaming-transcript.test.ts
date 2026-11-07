import { describe, expect, it } from 'bun:test';
import { createStreamingTranscriptLedger } from '../streaming-transcript';

describe('streaming transcript ledger', () => {
  it('accepts provider revisions of earlier recognition, including shrinkage', () => {
    const ledger = createStreamingTranscriptLedger();

    ledger.apply({ sequence: 0, committed: 'hello world', tentative: 'hello world and' });
    expect(ledger.apply({ sequence: 1, committed: 'hello there', tentative: 'hello there' })).toEqual({
      kind: 'accepted',
      committed: 'hello there',
      tentative: 'hello there',
    });
    expect(ledger.apply({ sequence: 2, committed: 'hello', tentative: 'hello th' })).toEqual({
      kind: 'accepted',
      committed: 'hello',
      tentative: 'hello th',
    });
    expect(ledger.current()).toEqual({ committed: 'hello', tentative: 'hello th' });
  });

  it('fails closed, terminally, on out-of-order or malformed snapshots', () => {
    const malformed = [
      { sequence: 1, committed: 'again', tentative: 'again' },
      { sequence: 2.5, committed: 'x', tentative: 'x' },
      { sequence: 3, committed: 'abc', tentative: 'xyz' },
      { sequence: 4, committed: undefined as unknown as string, tentative: '' },
    ];
    for (const snapshot of malformed) {
      const ledger = createStreamingTranscriptLedger();
      ledger.apply({ sequence: 1, committed: 'first', tentative: 'first' });
      expect(ledger.apply(snapshot)).toEqual({ kind: 'protocol-failure' });
      expect(ledger.apply({ sequence: 10, committed: 'later', tentative: 'later' }))
        .toEqual({ kind: 'protocol-failure' });
      expect(ledger.current()).toEqual({ committed: 'first', tentative: 'first' });
    }
  });
});
