import { describe, expect, it } from 'bun:test';
import {
  isDictationResultStillDeliverable,
  markDictationResultPending,
} from '../dictation-result-delivery';

describe('dictation result delivery gate', () => {
  it('marks only the newest dictation session as deliverable', () => {
    markDictationResultPending('session-probe');

    expect(isDictationResultStillDeliverable('session-probe')).toBe(true);
    expect(isDictationResultStillDeliverable('never-marked')).toBe(false);
  });

  it('drops stale dictation results after a newer session begins routing', () => {
    markDictationResultPending('session-1');
    expect(isDictationResultStillDeliverable('session-1')).toBe(true);

    markDictationResultPending('session-2');
    expect(isDictationResultStillDeliverable('session-1')).toBe(false);
    expect(isDictationResultStillDeliverable('session-2')).toBe(true);
  });
});
