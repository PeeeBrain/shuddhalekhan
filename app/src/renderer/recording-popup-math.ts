/**
 * The pill's dot field: a fixed grid of faint dots in the intent's tint.
 * While recording, two braided strands light the dots they pass through and
 * swell with the voice; at silence they fold into one still centre line.
 * While processing, a narrower field carries a soft beam across that line.
 */
export const FIELD_ROWS = 7;
export const VOICE_COLUMNS = 15;
export const WORK_COLUMNS = 7;
/** Unlit dots stay visible at this alpha so the field keeps its shape at rest. */
export const DOT_BASE_ALPHA = 0.16;

/** CSS-pixel dot metrics; drawn snapped to whole device pixels. */
const DOT_PITCH = 4;
const DOT_SIZE = 2;
const FRAME_MS = 1000 / 60;
/** Frames closer together than this are skipped, capping drawing near 60 Hz. */
export const MIN_FRAME_MS = FRAME_MS - 1;
const ATTACK_MS = 40;
const RELEASE_MS = 180;
/** One processing beam pass. */
export const SWEEP_MS = 1200;
const SWEEP_HALF_WIDTH = 1.5;
/** The resting line's brightness at the field's ends; full at the centre. */
const LINE_REST = 0.45;

/**
 * Dot geometry in device pixels. At fractional scale factors (125%, 150%)
 * CSS-sized dots land on fractional pixels and antialias unevenly, so pitch
 * and size are whole device pixels and every dot sits on the pixel grid.
 */
export function layoutDots(columns: number, rows: number, dpr: number) {
  const pitch = Math.max(2, Math.round(DOT_PITCH * dpr));
  const size = Math.max(1, Math.min(pitch - 1, Math.round(DOT_SIZE * dpr)));
  return {
    pitch,
    size,
    canvasWidth: (columns - 1) * pitch + size,
    canvasHeight: (rows - 1) * pitch + size,
  };
}

/** 1 at the field's centre column, easing to 0 at its ends: the capsule taper. */
function taper(column: number, columns: number): number {
  return Math.cos((spread(column, columns) * Math.PI) / 2);
}

/** A column's position from -1 at the left edge to 1 at the right. */
const spread = (column: number, columns: number) => (2 * column) / (columns - 1) - 1;

/** Row-major dot intensities (0–1) for a voice level (0–1) and braid phase (radians). */
export function voiceField(level: number, phase: number): number[] {
  const columns = VOICE_COLUMNS;
  const rows = FIELD_ROWS;
  const mid = (rows - 1) / 2;
  // Speech mostly arrives at 0.1–0.4; the root lifts it so ordinary talking fills the field.
  const loud = Math.min(1, Math.sqrt(Math.max(0, level)) * 1.3);
  const out: number[] = [];
  for (let row = 0; row < rows; row++) {
    const y = row - mid;
    for (let column = 0; column < columns; column++) {
      const env = taper(column, columns);
      const u = spread(column, columns);
      const amplitude = loud * mid * env;
      const a = amplitude * Math.sin(phase + 2.4 * u);
      const b = amplitude * Math.sin(phase * 0.77 - 3.1 * u + 2);
      const lit = Math.max(0, 1 - Math.abs(y - a), 1 - Math.abs(y - b));
      out.push(lit * (LINE_REST + (1 - LINE_REST) * Math.max(env, loud)));
    }
  }
  return out;
}

/**
 * Row-major dot intensities for the processing beam, `progress` 0–1 through
 * one pass. The beam enters fully off the left edge and leaves off the right,
 * so 0.5 holds it on the centre column.
 */
export function sweepField(progress: number): number[] {
  const columns = WORK_COLUMNS;
  const rows = FIELD_ROWS;
  const mid = (rows - 1) / 2;
  const travel = columns - 1 + 4 * SWEEP_HALF_WIDTH;
  const beam = progress * travel - 2 * SWEEP_HALF_WIDTH;
  const out: number[] = [];
  for (let row = 0; row < rows; row++) {
    const y = Math.abs(row - mid) / mid;
    for (let column = 0; column < columns; column++) {
      const lit = Math.max(0, 1 - Math.abs(column - beam) / SWEEP_HALF_WIDTH) * (1 - 0.65 * y);
      const line = row === mid ? LINE_REST * (0.6 + 0.4 * taper(column, columns)) : 0;
      out.push(Math.max(lit, line));
    }
  }
  return out;
}

export const COMPUTE_COLUMNS = 13;
const COMPUTE_ROWS = 3;
/** The thinking matrix steps like an LED panel, about 11 times a second. */
export const COMPUTE_STEP_MS = 90;
const COMPUTE_TRAIL = 4;
const COMPUTE_DENSITY = 0.11;

/** A stateless 0–1 hash of a dot and a step, so every frame is reproducible from time alone. */
function flip(dot: number, step: number): number {
  let h = Math.imul(dot + 1, 0x27d4eb2d) ^ Math.imul(step, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * Row-major dot intensities for the Agent's thinking matrix at a time in ms:
 * bits flip on and fade over a few steps while a read head walks the columns.
 */
export function computeField(timeMs: number): number[] {
  const step = Math.floor(timeMs / COMPUTE_STEP_MS);
  const head = step % (COMPUTE_COLUMNS + 6);
  const out: number[] = [];
  for (let dot = 0; dot < COMPUTE_COLUMNS * COMPUTE_ROWS; dot++) {
    let lit = dot % COMPUTE_COLUMNS === head ? 0.6 : 0;
    for (let age = 0; age < COMPUTE_TRAIL; age++) {
      if (flip(dot, step - age) < COMPUTE_DENSITY) {
        lit = Math.max(lit, 1 - age / COMPUTE_TRAIL);
        break;
      }
    }
    out.push(lit);
  }
  return out;
}

/**
 * Advances the voice by elapsed time, not per frame, so a 240 Hz display moves
 * at the same speed as a 60 Hz one. The level rises fast and decays slowly, and
 * the braid turns faster as the voice gets louder.
 */
export function stepVoice(level: number, phase: number, target: number, elapsedMs: number) {
  const dt = Math.min(Math.max(elapsedMs, 0), 4 * FRAME_MS);
  const tau = target > level ? ATTACK_MS : RELEASE_MS;
  const approach = (target - level) * (1 - Math.exp(-dt / tau));
  // The level's exact integral over the step, so the braid's turn doesn't depend on frame rate.
  const levelMs = target * dt - approach * tau;
  return {
    level: level + approach,
    phase: phase + (2 * dt + 6 * levelMs) / 1000,
  };
}

/** Below this level the mic counts as silent and the field stops repainting. */
export const SILENCE_LEVEL = 0.03;

/** True once both the incoming and smoothed levels are silent, so the rAF loop can park. */
export function isWaveformSettled(target: number, level: number): boolean {
  return target < SILENCE_LEVEL && level < SILENCE_LEVEL;
}

/** A synthetic voice for the pill preview: phrases of syllables with breaths between, 0–1. */
export function demoLevel(timeMs: number): number {
  const within = (timeMs / 1000) % 2.4;
  if (within > 1.7) return 0;
  const phrase = Math.sin((Math.PI * within) / 1.7);
  const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4.5 * within);
  return 0.05 + 0.6 * phrase * syllable;
}
