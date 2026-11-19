// Dictation admission: which finished recordings are worth sending to
// recognition. Agent Mode never asks. Shaped after Hex's hold threshold and
// level gate (github.com/anomalyco/hex, MIT, src/dictation.rs at 94cbe24) but
// without its neural speech detector, so the level constants here are looser,
// tuned on synthetic speech (four voices, short words, -25 to -60 dBFS over
// -70/-80 dBFS noise, and 3 dB over -56 to -64 dBFS rooms): none of it is discarded. Anything the gate cannot rule
// out goes to recognition, so only confidently empty input is discarded.

/** A push-to-talk hold shorter than this, press to release, is an accidental tap. */
export const MIN_HOLD_MS = 300;

const WINDOW_SAMPLES = 480; // 30 ms at 16 kHz
/** A sustained run this loud always goes to recognition... */
const LOUD_DBFS = -50;
/** ...and so does one this far above the clip's own noise floor... */
const RELATIVE_MARGIN_DB = 3; // Parakeet still hears words 3 dB over a -60 dBFS room; steady noise varies less
/** ...but never below this, however quiet the floor. */
const RELATIVE_FLOOR_DBFS = -66;
/** Sustained: 90 ms in one run, one quiet window bridged. Short words pass; key clicks don't. */
const SUSTAINED_WINDOWS = 3;
/** Where digital silence and a constant offset sit. */
const LEVEL_FLOOR_DBFS = -120;

/** DC-removed RMS level of each 30 ms window, in dBFS. */
function windowLevels(pcm: Int16Array): number[] {
  const levels: number[] = [];
  for (let start = 0; start < pcm.length; start += WINDOW_SAMPLES) {
    const end = Math.min(start + WINDOW_SAMPLES, pcm.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += pcm[i];
    const mean = sum / (end - start);
    let variance = 0;
    for (let i = start; i < end; i++) variance += (pcm[i] - mean) ** 2;
    levels.push(dbfs(variance / (end - start)));
  }
  return levels;
}

/** dBFS of a window's sample variance, floored where digital silence sits. */
function dbfs(variance: number): number {
  return Math.max(LEVEL_FLOOR_DBFS, 20 * Math.log10(Math.max(Math.sqrt(variance) / 32_768, 1e-6)));
}

/** Longest run of windows at or above `threshold`; a single quiet window inside a run is bridged, not counted. */
function longestRun(levels: number[], threshold: number): number {
  let run = 0;
  let longest = 0;
  let bridged = false;
  for (const level of levels) {
    if (level >= threshold) {
      run += 1;
      longest = Math.max(longest, run);
      bridged = false;
    } else if (run > 0 && !bridged) {
      bridged = true;
    } else {
      run = 0;
      bridged = false;
    }
  }
  return longest;
}

/**
 * True when 16 kHz mono PCM holds nothing recognition should hear: no
 * sustained loud run and no sustained rise above its own noise floor (the
 * 10th-percentile window). Key clicks are too short to count. A clip with no
 * signal at all (all zeros or a constant offset) is a device problem, not an
 * empty utterance, so it is not discarded: recognition's no-speech error tells
 * the user to check the microphone. Trailing quiet audio, such as a release
 * tail, only lowers the noise floor and so never turns speech into silence.
 * The first `skipSamples` (pre-roll, cue head) are not judged, but if they hold
 * signal the device works, so a flat remainder is discarded: recognition would
 * hear only the skipped audio.
 */
export function isNearSilent(pcm: Int16Array, skipSamples = 0): boolean {
  const levels = windowLevels(pcm.subarray(skipSamples));
  if (longestRun(levels, LOUD_DBFS) >= SUSTAINED_WINDOWS) return false;
  if (!levels.some(level => level > LEVEL_FLOOR_DBFS)) {
    return windowLevels(pcm.subarray(0, skipSamples)).some(level => level > LEVEL_FLOOR_DBFS);
  }
  return longestRun(levels, relativeThreshold(levels)) < SUSTAINED_WINDOWS;
}

/** The level a window must reach over the clip's own noise floor (its 10th-percentile window) to count as sound. */
function relativeThreshold(levels: number[]): number {
  // Gated (noise-suppressed) silence counts toward the floor, so a quiet word between zeros still stands out.
  const sorted = [...levels].sort((a, b) => a - b);
  return Math.max(sorted[Math.floor((sorted.length - 1) / 10)] + RELATIVE_MARGIN_DB, RELATIVE_FLOOR_DBFS);
}

/**
 * How many head samples of a recording to drop: the part of its first
 * `preRoll` samples that a pause (two quiet windows back to back, so one is
 * bridged as in the gate) separates from the speech after it, such as a TV
 * line or a cough before the user spoke. The pause may start anywhere up to
 * the press and run past it; the cut never does. Speech running into the
 * press keeps its start, with one quiet window before it.
 */
export function detachedPreRoll(pcm: Int16Array, preRoll: number): number {
  const head = Math.min(preRoll, pcm.length);
  const pause = 2 * WINDOW_SAMPLES;
  if (head === 0 || pcm.length < pause) return 0;
  const quiet = Math.min(LOUD_DBFS, relativeThreshold(windowLevels(pcm)));
  // Running sums give any window's level, so a pause is found wherever it falls, not just on the 30 ms grid.
  const end = Math.min(head + pause, pcm.length);
  const sums = new Float64Array(end + 1);
  const squares = new Float64Array(end + 1);
  for (let i = 0; i < end; i++) {
    sums[i + 1] = sums[i] + pcm[i];
    squares[i + 1] = squares[i] + pcm[i] ** 2;
  }
  const isQuiet = (start: number) => {
    const sum = sums[start + WINDOW_SAMPLES] - sums[start];
    const variance = (squares[start + WINDOW_SAMPLES] - squares[start] - sum * sum / WINDOW_SAMPLES) / WINDOW_SAMPLES;
    return dbfs(Math.max(0, variance)) < quiet;
  };
  // The newest pause wins: the cut lands one window before the speech after it.
  for (let start = Math.min(head, end - pause); start >= 0; start--) {
    if (isQuiet(start + WINDOW_SAMPLES) && isQuiet(start)) return Math.min(start + WINDOW_SAMPLES, head);
  }
  return 0;
}
