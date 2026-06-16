import { beforeEach, describe, expect, it } from 'bun:test';
import {
  clearLastTranscript,
  getLastTranscript,
  markLastTranscriptInjected,
  setLastTranscript,
} from '../last-transcript';

describe('last transcript store', () => {
  beforeEach(() => {
    clearLastTranscript();
  });

  it('stores a non-empty transcript and exposes it', () => {
    setLastTranscript('hello world');

    const stored = getLastTranscript();
    expect(stored?.text).toBe('hello world');
    expect(stored?.injectionStatus).toBe('pending');
    expect(stored?.createdAt).toBeString();
  });

  it('does not store empty transcripts', () => {
    setLastTranscript('');

    expect(getLastTranscript()).toBeNull();
  });

  it('replaces the previous transcript with a newer one', () => {
    setLastTranscript('first');
    setLastTranscript('second');

    expect(getLastTranscript()?.text).toBe('second');
  });

  it('updates injection status', () => {
    setLastTranscript('hello world');
    markLastTranscriptInjected('dispatched');

    expect(getLastTranscript()?.injectionStatus).toBe('dispatched');
  });

  it('clears the stored transcript', () => {
    setLastTranscript('hello world');
    clearLastTranscript();

    expect(getLastTranscript()).toBeNull();
  });
});
