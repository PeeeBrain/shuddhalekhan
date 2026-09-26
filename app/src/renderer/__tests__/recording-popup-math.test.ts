import { describe, expect, it } from 'bun:test';
import { computeBarScale, SCALE_BASE, SCALE_MAX, SCALE_MIN } from '../recording-popup-math';

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
