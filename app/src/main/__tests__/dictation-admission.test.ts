import { describe, expect, it } from 'bun:test';
import { isNearSilent } from '../dictation-admission';

const ms = (duration: number) => duration * 16;

/** Deterministic white noise at an RMS level in dBFS. */
function noise(dbfs: number, samples: number, seed = 1): number[] {
  const amplitude = 10 ** (dbfs / 20) * Math.sqrt(3) * 32_768; // uniform RMS = a/√3
  let state = seed;
  return Array.from({ length: samples }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return Math.round((state / 2 ** 30 - 1) * amplitude);
  });
}

/** A 200 Hz tone at an RMS level in dBFS; stands in for voiced speech. */
const tone = (dbfs: number, samples: number) =>
  Array.from({ length: samples }, (_, i) => Math.round(10 ** (dbfs / 20) * Math.SQRT2 * 32_768 * Math.sin(i * 2 * Math.PI * 200 / 16_000)));

const clip = (...parts: number[][]) => Int16Array.from(parts.flat());

describe('isNearSilent', () => {
  it.each([
    ['room noise alone', clip(noise(-72, ms(1500))), true],
    ['a louder constant floor alone', clip(noise(-60, ms(2000))), true],
    ['loud key clicks at press and release', clip(noise(-20, ms(5), 3), noise(-72, ms(1000)), noise(-20, ms(5), 4), noise(-72, ms(300), 2)), true],
    ['whisper-level speech in silence', clip(noise(-80, ms(500)), tone(-43, ms(100)), noise(-80, ms(400), 2)), false],
    ['a short word 10 dB over the room, then a release tail', clip(noise(-70, ms(300)), tone(-60, ms(250)), noise(-70, ms(600), 2)), false],
    ['a quiet word between noise-suppressed (zeroed) pauses', clip(new Array(ms(300)).fill(0), tone(-60, ms(300)), new Array(ms(600)).fill(0)), false],
    ['ordinary speech', clip(tone(-25, ms(1000))), false],
    // A muted or broken device: recognition's no-speech notice should name the microphone.
    ['digital silence', clip(new Array(ms(1000)).fill(0)), false],
  ] as const)('%s → %p', (_name: string, pcm: Int16Array, silent: boolean) => {
    expect(isNearSilent(pcm)).toBe(silent);
  });
});
