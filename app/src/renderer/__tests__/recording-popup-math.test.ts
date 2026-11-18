import { describe, expect, it } from 'bun:test';
import { BAND_COUNT, bandsFromSpectrum } from '../audio-level';
import {
  FIELD_ROWS,
  isWaveformSettled,
  layoutDots,
  smoothLevel,
  spectrumField,
  sweepField,
  VOICE_COLUMNS,
  WORK_COLUMNS,
} from '../recording-popup-math';

const MID = (FIELD_ROWS - 1) / 2;
const CENTRE = (VOICE_COLUMNS - 1) / 2;
const rowsOf = (field: number[], columns: number) =>
  Array.from({ length: FIELD_ROWS }, (_, row) => field.slice(row * columns, (row + 1) * columns));
const columnOf = (field: number[], column: number) => rowsOf(field, VOICE_COLUMNS).map((row) => row[column]);
const bandsWith = (entries: Record<number, number>) => {
  const bands = new Float32Array(BAND_COUNT);
  for (const [band, level] of Object.entries(entries)) bands[Number(band)] = level;
  return bands;
};

describe('spectrumField', () => {
  it('folds into one still centre line at silence', () => {
    rowsOf(spectrumField(new Float32Array(BAND_COUNT)), VOICE_COLUMNS).forEach((row, index) => {
      if (index === MID) expect(Math.min(...row)).toBeGreaterThan(0);
      else expect(Math.max(...row)).toBe(0);
    });
  });

  it('raises only the columns of the bands that carry sound, mirrored lows-in-the-centre', () => {
    const field = spectrumField(bandsWith({ 0: 1, 6: 0.5 }));
    const lit = (column: number) => columnOf(field, column).reduce((sum, value) => sum + value, 0);
    // The loudest band, the lows, fills the centre column top to bottom.
    expect(Math.min(...columnOf(field, CENTRE))).toBe(1);
    // Band 6 lights the same height on both sides; a silent band between stays on the line.
    expect(columnOf(field, CENTRE - 6)).toEqual(columnOf(field, CENTRE + 6));
    expect(lit(CENTRE + 6)).toBeGreaterThan(lit(CENTRE + 3));
    expect(lit(CENTRE)).toBeGreaterThan(lit(CENTRE + 6));
  });
});

describe('bandsFromSpectrum', () => {
  it('puts a voiced tone in its own band and leaves silent bands at rest', () => {
    const binHz = 16_000 / 512;
    const db = new Float32Array(256).fill(-120);
    db[Math.round(300 / binHz)] = -30;
    const bands = new Float32Array(BAND_COUNT);
    bandsFromSpectrum(db, binHz, bands);
    const loudest = bands.indexOf(Math.max(...bands));
    expect(bands[loudest]).toBeGreaterThan(0.8);
    expect([...bands].filter((_, band) => band !== loudest)).toEqual(new Array(BAND_COUNT - 1).fill(0));
    // 300 Hz is low voice: it lands in the lower half, near the field's centre.
    expect(loudest).toBeLessThan(BAND_COUNT / 2);
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

describe('smoothLevel', () => {
  it('animates at the same speed on a 240 Hz display as on 60 Hz', () => {
    let at60 = 0;
    for (let i = 0; i < 6; i++) at60 = smoothLevel(at60, 1, 1000 / 60);
    let at240 = 0;
    for (let i = 0; i < 24; i++) at240 = smoothLevel(at240, 1, 1000 / 240);
    expect(at240).toBeCloseTo(at60, 10);
  });

  it('rises to a syllable faster than it decays after one', () => {
    expect(smoothLevel(0, 1, 50)).toBeGreaterThan(1 - smoothLevel(1, 0, 50));
  });
});

describe('isWaveformSettled', () => {
  it('parks only when both target and smoothed level are silent', () => {
    expect(isWaveformSettled(0, 0.01)).toBe(true);
    expect(isWaveformSettled(0, 0.2)).toBe(false);
    expect(isWaveformSettled(0.2, 0)).toBe(false);
  });
});
