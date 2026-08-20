import { describe, expect, it } from 'bun:test';
import { createStreamingTranscriptLedger } from '../streaming-transcript';

describe('streaming transcript ledger', () => {
  it('accepts repeated and raw-prefix-extending commits without normalizing provider text', () => {
    const ledger = createStreamingTranscriptLedger();

    expect(ledger.apply({ sequence: 0, committed: 'hello ', tentative: 'hello w' })).toEqual({
      kind: 'accepted',
      committed: 'hello ',
      tentative: 'hello w',
    });
    expect(ledger.apply({ sequence: 1, committed: 'hello ', tentative: 'hello wo' })).toEqual({
      kind: 'accepted',
      committed: 'hello ',
      tentative: 'hello wo',
    });
    expect(ledger.apply({ sequence: 2, committed: 'hello world', tentative: 'hello world' })).toEqual({
      kind: 'accepted',
      committed: 'hello world',
      tentative: 'hello world',
    });
  });

  it('fails closed on out-of-order snapshots, shrinkage, or revision', () => {
    const outOfOrder = createStreamingTranscriptLedger();
    outOfOrder.apply({ sequence: 1, committed: 'first', tentative: 'first' });
    expect(outOfOrder.apply({ sequence: 1, committed: 'first again', tentative: 'first again' }))
      .toEqual({ kind: 'protocol-failure' });

    const shrink = createStreamingTranscriptLedger();
    shrink.apply({ sequence: 0, committed: 'complete', tentative: 'complete' });
    expect(shrink.apply({ sequence: 1, committed: 'complet', tentative: 'complet' }))
      .toEqual({ kind: 'protocol-failure' });

    const revision = createStreamingTranscriptLedger();
    revision.apply({ sequence: 0, committed: 'hello world', tentative: 'hello world' });
    expect(revision.apply({ sequence: 1, committed: 'hello there', tentative: 'hello there' }))
      .toEqual({ kind: 'protocol-failure' });
  });

  it('treats the protocol-failure latch as terminal', () => {
    const ledger = createStreamingTranscriptLedger();
    ledger.apply({ sequence: 0, committed: 'first', tentative: 'first' });
    expect(ledger.apply({ sequence: 0, committed: 'first again', tentative: 'first again' }))
      .toEqual({ kind: 'protocol-failure' });
    expect(ledger.apply({ sequence: 1, committed: 'first', tentative: 'first' }))
      .toEqual({ kind: 'protocol-failure' });
  });

  it('discards tentative text at the finalization barrier', () => {
    const ledger = createStreamingTranscriptLedger();
    ledger.apply({ sequence: 0, committed: 'stable', tentative: 'stable maybe' });

    expect(ledger.finalize()).toBe('stable');
    expect(ledger.current()).toEqual({ committed: 'stable', tentative: '' });
  });
});
