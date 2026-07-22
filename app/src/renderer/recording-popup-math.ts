// Tuning constants for the waveform animation.
export const BAR_COUNT = 10;
export const SMOOTHING_FACTOR = 0.22;
export const PHASE_STEP = 0.09;
export const WAVE_FREQUENCY = 0.75;
export const WAVE_BASE_AMPLITUDE = 0.15;
export const WAVE_LEVEL_AMPLITUDE = 0.25;
export const SCALE_BASE = 0.35;
export const SCALE_LEVEL_GAIN = 0.85;
export const SCALE_MIN = 0.25;
export const SCALE_MAX = 1.4;

export function computeBarScale(level: number, phase: number, index: number): number {
  const wave = Math.sin(phase + index * WAVE_FREQUENCY) * (WAVE_BASE_AMPLITUDE + level * WAVE_LEVEL_AMPLITUDE);
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, SCALE_BASE + level * SCALE_LEVEL_GAIN + wave));
}
