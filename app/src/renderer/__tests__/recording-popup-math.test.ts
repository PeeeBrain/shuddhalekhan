import { describe, expect, it } from 'bun:test';
import {
  computeBarScale,
  isWaveformSettled,
  layoutBars,
  SCALE_BASE,
  SCALE_MAX,
  SCALE_MIN,
  stepWaveform,
} from '../recording-popup-math';

describe('computeBarScale', () => {
  it('returns the base scale at zero level and zero phase for index 0', () => {
    const scale = computeBarScale(0, 0, 0);
    expect(scale).toBe(SCALE_BASE);
  });

  it('clamps the scale to the minimum', () => {
    // Pick parameters that drive the raw value far below SCALE_MIN.
    const scale = computeBarScale(0, Math.PI * 1.5, 0);
    expect(scale).toBe(SCALE_MIN);
  });

  it('clamps the scale to the maximum', () => {
    // Pick parameters that drive the raw value far above SCALE_MAX.
    const scale = computeBarScale(1, Math.PI * 0.5, 0);
    expect(scale).toBe(SCALE_MAX);
  });

  it('increases with higher audio levels', () => {
    const quiet = computeBarScale(0.1, 0, 2);
    const loud = computeBarScale(0.9, 0, 2);
    expect(loud).toBeGreaterThan(quiet);
  });

  it('produces different scales for different bar indices', () => {
    const phase = 1;
    const s0 = computeBarScale(0.5, phase, 0);
    const s1 = computeBarScale(0.5, phase, 1);
    expect(s0).not.toBe(s1);
  });

  it('stays within bounds across a range of inputs', () => {
    for (let level = 0; level <= 1; level += 0.1) {
      for (let phase = 0; phase <= Math.PI * 2; phase += 0.5) {
        for (let index = 0; index < 10; index++) {
          const scale = computeBarScale(level, phase, index);
          expect(scale).toBeGreaterThanOrEqual(SCALE_MIN);
          expect(scale).toBeLessThanOrEqual(SCALE_MAX);
        }
      }
    }
  });
});

describe('isWaveformSettled', () => {
  it('parks only when both target and smoothed level are silent', () => {
    expect(isWaveformSettled(0, 0.01)).toBe(true);
    expect(isWaveformSettled(0, 0.2)).toBe(false);
    expect(isWaveformSettled(0.2, 0)).toBe(false);
  });
});

describe('layoutBars', () => {
  it('keeps every bar on whole device pixels at fractional display scales', () => {
    const scales = Array.from({ length: 10 }, (_, index) => computeBarScale(0.6, 1.3, index));
    for (const dpr of [1, 1.25, 1.5, 1.75, 2]) {
      const { canvasHeight, bars } = layoutBars(scales, dpr);
      const [first, second] = bars;
      for (const [index, bar] of bars.entries()) {
        expect(Number.isInteger(bar.x) && Number.isInteger(bar.y) && Number.isInteger(bar.height)).toBe(true);
        expect(bar.width).toBe(first.width); // equal widths: no 2px/3px alternation
        expect(bar.x).toBe(index * (second.x - first.x)); // equal gaps
        expect(bar.y * 2 + bar.height).toBe(canvasHeight); // centred, not half a pixel off
      }
    }
  });
});

describe('stepWaveform', () => {
  it('animates at the same speed on a 240 Hz display as on 60 Hz', () => {
    let at60 = { level: 0, phase: 0 };
    for (let i = 0; i < 6; i++) at60 = stepWaveform(at60.level, at60.phase, 1, 1000 / 60);
    let at240 = { level: 0, phase: 0 };
    for (let i = 0; i < 24; i++) at240 = stepWaveform(at240.level, at240.phase, 1, 1000 / 240);

    expect(at240.level).toBeCloseTo(at60.level, 10);
    expect(at240.phase).toBeCloseTo(at60.phase, 10);
  });
});
