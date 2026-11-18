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
    const rms = Math.sqrt(variance / (end - start)) / 32_768;
    levels.push(Math.max(LEVEL_FLOOR_DBFS, 20 * Math.log10(Math.max(rms, 1e-6))));
  }
  return levels;
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
  // Gated (noise-suppressed) silence counts toward the floor, so a quiet word between zeros still stands out.
  const sorted = [...levels].sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor((sorted.length - 1) / 10)];
  const threshold = Math.max(noiseFloor + RELATIVE_MARGIN_DB, RELATIVE_FLOOR_DBFS);
  return longestRun(levels, threshold) < SUSTAINED_WINDOWS;
}
