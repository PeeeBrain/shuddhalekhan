import { describe, expect, it } from 'bun:test';
import {
  characterErrorRate,
  levenshteinDistance,
  normalizeTranscript,
  wordErrorRate,
} from '../transcription-quality';

describe('transcription quality metrics', () => {
  it('normalizes punctuation, case, and spacing before comparison', () => {
    expect(normalizeTranscript('  Hello,   WORLD!!! ')).toBe('hello world');
  });

  it('computes edit distance for word and character sequences', () => {
    expect(levenshteinDistance(['one', 'two', 'three'], ['one', 'too', 'three'])).toBe(1);
    expect(levenshteinDistance(Array.from('kitten'), Array.from('sitting'))).toBe(3);
  });

  it('computes word error rate against the expected transcript', () => {
    expect(wordErrorRate('one two three', 'one two three')).toBe(0);
    expect(wordErrorRate('one too three', 'one two three')).toBeCloseTo(1 / 3);
    expect(wordErrorRate('one two three extra', 'one two three')).toBeCloseTo(1 / 3);
  });

  it('computes character error rate against the expected transcript', () => {
    expect(characterErrorRate('नमस्कार', 'नमस्कार')).toBe(0);
    expect(characterErrorRate('नमस्कर', 'नमस्कार')).toBeCloseTo(1 / 7);
  });
});
