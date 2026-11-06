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

/** CSS-pixel bar metrics; drawn snapped to whole device pixels. */
export const BAR_WIDTH = 2;
export const BAR_GAP = 3;
export const BAR_HEIGHT = 16;
export const WAVEFORM_HEIGHT = 32;
const FRAME_MS = 1000 / 60;

/**
 * Bar rectangles in device pixels. At fractional scale factors (125%, 150%)
 * CSS-sized bars land on fractional pixels and antialias to uneven widths, so
 * width, gap, height and vertical centering are all rounded to whole pixels.
 */
export function layoutBars(scales: readonly number[], dpr: number) {
  const width = Math.max(1, Math.round(BAR_WIDTH * dpr));
  const gap = Math.max(1, Math.round(BAR_GAP * dpr));
  const canvasHeight = Math.round(WAVEFORM_HEIGHT * dpr);
  const canvasWidth = scales.length * width + (scales.length - 1) * gap;
  const bars = scales.map((scale, index) => {
    let height = Math.max(width, Math.round(BAR_HEIGHT * dpr * scale));
    height += (canvasHeight - height) % 2; // even margins keep the bar on the pixel grid
    return { x: index * (width + gap), y: (canvasHeight - height) / 2, width, height };
  });
  return { canvasWidth, canvasHeight, bars };
}

/**
 * Advances smoothing and phase by elapsed time, not per frame, so a 240 Hz
 * display animates at the same speed as a 60 Hz one.
 */
export function stepWaveform(level: number, phase: number, target: number, elapsedMs: number) {
  const frames = Math.min(Math.max(elapsedMs / FRAME_MS, 0), 4);
  return {
    level: level + (target - level) * (1 - (1 - SMOOTHING_FACTOR) ** frames),
    phase: phase + PHASE_STEP * frames,
  };
}

/** Below this level the mic counts as silent and the waveform stops repainting. */
export const SILENCE_LEVEL = 0.03;

/** True once both the incoming and smoothed levels are silent, so the rAF loop can park. */
export function isWaveformSettled(target: number, level: number): boolean {
  return target < SILENCE_LEVEL && level < SILENCE_LEVEL;
}
