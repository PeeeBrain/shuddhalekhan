import { describe, expect, test } from 'bun:test';
import { accept, normalize, scoreClip, type Result } from '../eval/score';

const REF = 'Please send the report to Ravi.';
const run = { coldStartMs: 1000, peakRssMb: 500, cpuMsPerClip: 100 };
const result = (timings: (i: number) => number[], hypothesis: string, stats = run): Result => ({
  set: 'dev',
  layer: 'model',
  fingerprint: 'f',
  clips: Array.from({ length: 30 }, (_, i) => scoreClip(String(i), REF, hypothesis, timings(i))),
  run: stats,
});
const steady = (ms: number) => (i: number) => Array.from({ length: 20 }, () => ms + (i % 5));

describe('eval scorer', () => {
  test('ordinary words that name inherited properties are not numbers', () => {
    expect(normalize('one constructor')).toEqual(['1', 'constructor']);
    expect(normalize('constructor one')).toEqual(['constructor', '1']);
  });

  test('splits deletions from insertions and scores punctuation/case separately', () => {
    expect(scoreClip('a', REF, 'please send report to ravi today'))
      .toMatchObject({ words: 6, errors: 2, deletions: 1, insertions: 1, firstThreeWrong: true });
    expect(scoreClip('b', 'Hello, Ravi.', 'hello ravi')).toMatchObject({ errors: 0, rawErrors: 2 });
  });

  test('WER ignores how numbers, fillers and British spellings are written, but not what was said', () => {
    const clip = scoreClip('c', 'Call 377138354339 near the ESIC centre, Act 1999.',
      'Call three double seven one three eight three five four three three nine near the uh ESIC center, Act nineteen ninety-nine.');
    expect(clip.errors).toBe(0);
    expect(clip.rawErrors).toBeGreaterThan(0);
    expect(normalize('2 lakh 50 thousand')).toEqual(normalize('two lakh fifty thousand'));
    expect(normalize('1.5 lakh')).not.toEqual(normalize('15 lakh'));
    expect(normalize('exercize')).not.toEqual(normalize('exercise'));
  });

  test('passes a clear latency win and fails when nothing improved or a guardrail breaks', () => {
    const baseline = result(steady(400), REF);
    expect(accept(result(steady(300), REF), baseline).pass).toBe(true);
    expect(accept(result(steady(400), REF), baseline).pass).toBe(false);
    expect(accept(result(steady(300), REF, { ...run, coldStartMs: 2500 }), baseline).guardrails.coldStart).toBe(false);
  });

  test('a win cannot hide slow decodes or a regression in a protected metric', () => {
    const spiky = result(() => [...Array(11).fill(90), ...Array(9).fill(1000)], REF);
    expect(accept(spiky, result(steady(100), REF)).headline.latencyP95Ms.low).toBeGreaterThan(0);

    const dropsWords = accept(result(steady(300), 'Please send the report Ravi.'), result(steady(400), 'Please send the report two Ravi.'));
    expect(dropsWords).toMatchObject({ pass: false, improved: true, regressed: true });
  });

  test('accuracy-only runs, duplicate ids and stale baselines cannot certify a change', () => {
    const baseline = result(steady(400), 'Please send report to Ravi.');
    expect(accept(result(() => [], REF), baseline)).toMatchObject({ pass: false, complete: false, improved: true });

    const duplicated = result(steady(300), REF);
    duplicated.clips[1] = { ...duplicated.clips[1], id: '0' };
    expect(() => accept(duplicated, baseline)).toThrow('Duplicate');
    expect(() => accept({ ...result(steady(300), REF), fingerprint: 'other' }, baseline)).toThrow('regenerate');
  });
});
