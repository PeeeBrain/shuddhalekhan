import { afterEach, describe, expect, it } from 'bun:test';
import {
  isDictationResultStillDeliverable,
  markDictationResultPending,
  resetDictationResultDeliveryForTests,
} from '../dictation-result-delivery';

describe('dictation result delivery gate', () => {
  afterEach(() => {
    resetDictationResultDeliveryForTests();
  });

  it('drops stale dictation results after a newer session begins routing', () => {
    markDictationResultPending('session-1');
    expect(isDictationResultStillDeliverable('session-1')).toBe(true);

    markDictationResultPending('session-2');
    expect(isDictationResultStillDeliverable('session-1')).toBe(false);
    expect(isDictationResultStillDeliverable('session-2')).toBe(true);
  });
});
