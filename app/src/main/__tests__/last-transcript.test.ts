import { describe, expect, it } from 'bun:test';
import {
  getLastTranscript,
  markLastTranscriptInjected,
  setLastTranscript,
} from '../last-transcript';

describe('last transcript store', () => {
  it('stores a non-empty transcript and exposes it', () => {
    setLastTranscript('probe-store-1');

    const stored = getLastTranscript();
    expect(stored?.text).toBe('probe-store-1');
    expect(stored?.injectionStatus).toBe('pending');
    expect(stored?.createdAt).toBeString();
  });

  it('does not store empty transcripts', () => {
    setLastTranscript('');

    expect(getLastTranscript()?.text).not.toBe('');
  });

  it('replaces the previous transcript with a newer one', () => {
    setLastTranscript('probe-first');
    setLastTranscript('probe-second');

    expect(getLastTranscript()?.text).toBe('probe-second');
  });

  it('updates injection status', () => {
    setLastTranscript('probe-status');
    markLastTranscriptInjected('dispatched');

    expect(getLastTranscript()?.injectionStatus).toBe('dispatched');
  });
});
