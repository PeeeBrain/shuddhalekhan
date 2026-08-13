import { describe, expect, it } from 'bun:test';
import { getRecoveryActions } from '../dictation-recovery';

describe('Batch Dictation recovery certainty', () => {
  it('allows exact-target retry only when no input event was accepted', () => {
    expect(getRecoveryActions({ kind: 'input-blocked', acceptedEvents: 0 })).toEqual([
      'retry-paste', 'copy-full-transcript',
    ]);
    expect(getRecoveryActions({ kind: 'input-blocked', acceptedEvents: 1 })).toEqual([
      'copy-full-transcript',
    ]);
  });

  it('uses copy-only recovery when paste acceptance is uncertain', () => {
    expect(getRecoveryActions({ kind: 'error', message: 'unknown native result' })).toEqual([
      'copy-full-transcript',
    ]);
    expect(getRecoveryActions({ kind: 'clipboard-conflict', reason: 'changed' })).toEqual([
      'retry-paste', 'copy-full-transcript',
    ]);
  });
});
