import { describe, expect, it } from 'bun:test';
import {
  FIELD_ROWS,
  isWaveformSettled,
  layoutDots,
  stepVoice,
  sweepField,
  VOICE_COLUMNS,
  voiceField,
  WORK_COLUMNS,
} from '../recording-popup-math';

const MID = (FIELD_ROWS - 1) / 2;
const rowsOf = (field: number[], columns: number) =>
  Array.from({ length: FIELD_ROWS }, (_, row) => field.slice(row * columns, (row + 1) * columns));

describe('voiceField', () => {
  it('folds into one still centre line at silence, whatever the phase', () => {
    for (const phase of [0, 1.3, 4]) {
      rowsOf(voiceField(0, phase), VOICE_COLUMNS).forEach((row, index) => {
        if (index === MID) expect(Math.min(...row)).toBeGreaterThan(0);
        else expect(Math.max(...row)).toBe(0);
      });
    }
  });

  it('lights dots away from the centre line as the voice gets louder', () => {
    const offLine = (level: number) =>
      rowsOf(voiceField(level, 1.3), VOICE_COLUMNS)
        .filter((_, index) => index !== MID)
        .flat()
        .reduce((sum, lit) => sum + lit, 0);
    expect(offLine(0.6)).toBeGreaterThan(offLine(0.2));
    expect(offLine(0.2)).toBeGreaterThan(0);
  });
});

describe('sweepField', () => {
  it('enters off the left edge and leaves off the right, so each pass wraps without a jump', () => {
    const resting = sweepField(0);
    expect(sweepField(1)).toEqual(resting);
    rowsOf(resting, WORK_COLUMNS).forEach((row, index) => {
      if (index !== MID) expect(Math.max(...row)).toBe(0);
    });
    const centre = rowsOf(sweepField(0.5), WORK_COLUMNS)[0];
    expect(centre.indexOf(Math.max(...centre))).toBe((WORK_COLUMNS - 1) / 2);
  });
});

describe('layoutDots', () => {
  it('keeps every dot on whole device pixels with a visible gap at fractional display scales', () => {
    for (const dpr of [1, 1.25, 1.5, 1.75, 2]) {
      const { pitch, size, canvasWidth, canvasHeight } = layoutDots(VOICE_COLUMNS, FIELD_ROWS, dpr);
      expect(Number.isInteger(pitch) && Number.isInteger(size)).toBe(true);
      expect(size).toBeLessThan(pitch);
      expect(canvasWidth).toBe((VOICE_COLUMNS - 1) * pitch + size);
      expect(canvasHeight).toBe((FIELD_ROWS - 1) * pitch + size);
    }
  });
});

describe('stepVoice', () => {
  it('animates at the same speed on a 240 Hz display as on 60 Hz', () => {
    let at60 = { level: 0, phase: 0 };
    for (let i = 0; i < 6; i++) at60 = stepVoice(at60.level, at60.phase, 1, 1000 / 60);
    let at240 = { level: 0, phase: 0 };
    for (let i = 0; i < 24; i++) at240 = stepVoice(at240.level, at240.phase, 1, 1000 / 240);

    expect(at240.level).toBeCloseTo(at60.level, 10);
    expect(at240.phase).toBeCloseTo(at60.phase, 10);
  });

  it('rises to a syllable faster than it decays after one', () => {
    const rise = stepVoice(0, 0, 1, 50).level;
    const fall = 1 - stepVoice(1, 0, 0, 50).level;
    expect(rise).toBeGreaterThan(fall);
  });
});

describe('isWaveformSettled', () => {
  it('parks only when both target and smoothed level are silent', () => {
    expect(isWaveformSettled(0, 0.01)).toBe(true);
    expect(isWaveformSettled(0, 0.2)).toBe(false);
    expect(isWaveformSettled(0.2, 0)).toBe(false);
  });
});
