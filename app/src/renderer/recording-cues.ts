import type { RecordingCue } from '../types/ipc';

// Original cues synthesized here, so there are no asset files to load or decode.
// Each cue is a short synth swell: a chord of slightly detuned sawtooth pairs
// that glides into pitch while a low-pass filter sweeps across it. Start opens
// upward on a major chord, Stop closes downward on one, and Error sinks on a darker
// minor chord. Start must end within START_CUE_HEAD_SAMPLES in main/recording-session.ts.
const CUES: Record<RecordingCue, {
  root: number;
  chord: number[];
  /** Pitch ratio the chord glides in from. */
  glideFrom: number;
  /** Low-pass cutoff in Hz at the start of the cue and halfway through it. */
  cutoff: [number, number];
  seconds: number;
}> = {
  start: { root: 523.25, chord: [1, 1.25, 1.5, 2], glideFrom: 0.75, cutoff: [500, 4200], seconds: 0.26 },
  stop: { root: 392, chord: [1, 1.25, 1.5, 2], glideFrom: 1.33, cutoff: [4200, 600], seconds: 0.4 },
  error: { root: 329.63, chord: [1, 1.19, 1.5], glideFrom: 1.06, cutoff: [1600, 400], seconds: 0.45 },
};
const DETUNE_CENTS = [-7, 7];
const GLIDE_SECONDS = 0.12;
const ATTACK_SECONDS = 0.03;
const PEAK_GAIN = 0.03;
const SILENT_GAIN = 0.0001;

let context: AudioContext | null = null;
let sounding = 0;

/**
 * Plays a cue; the context is suspended whenever nothing sounds, and then
 * `onSilent` runs. Never throws.
 */
export function playRecordingCue(cue: RecordingCue, onSilent?: () => void): void {
  try {
    context ??= new AudioContext({ latencyHint: 'interactive' });
    const ctx = context;
    void ctx.resume().catch(() => undefined);
    const { root, chord, glideFrom, cutoff, seconds } = CUES[cue];
    const start = ctx.currentTime + 0.01;
    const end = start + seconds;

    const filter = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 2, frequency: cutoff[0] });
    filter.frequency.setValueAtTime(cutoff[0], start);
    // The sweep finishes mid-cue, while the swell is still loud enough to hear it.
    filter.frequency.exponentialRampToValueAtTime(cutoff[1], start + seconds / 2);
    const envelope = new GainNode(ctx, { gain: SILENT_GAIN });
    envelope.gain.setValueAtTime(SILENT_GAIN, start);
    envelope.gain.exponentialRampToValueAtTime(PEAK_GAIN, start + ATTACK_SECONDS);
    envelope.gain.exponentialRampToValueAtTime(SILENT_GAIN, end);
    filter.connect(envelope).connect(ctx.destination);

    let voices = 0;
    for (const ratio of chord) {
      for (const detune of DETUNE_CENTS) {
        const hz = root * ratio;
        const oscillator = new OscillatorNode(ctx, { type: 'sawtooth', frequency: hz * glideFrom, detune });
        oscillator.frequency.setValueAtTime(hz * glideFrom, start);
        oscillator.frequency.exponentialRampToValueAtTime(hz, start + GLIDE_SECONDS);
        oscillator.connect(filter);
        voices += 1;
        sounding += 1;
        oscillator.onended = () => {
          oscillator.disconnect();
          if (--voices === 0) envelope.disconnect();
          if (--sounding === 0) {
            void ctx.suspend().catch(() => undefined);
            onSilent?.();
          }
        };
        oscillator.start(start);
        oscillator.stop(end);
      }
    }
  } catch (error) {
    console.warn('Recording cue could not play:', error);
    if (sounding === 0) onSilent?.();
  }
}
