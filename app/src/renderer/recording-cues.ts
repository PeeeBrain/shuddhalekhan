import type { RecordingCue } from '../types/ipc';

// Original cues synthesized here, so there are no asset files to load or decode.
// Each note is a soft chime: a sine with quieter overtones that fade faster than
// it, like a bell. Overlapping notes ring together as an interval. Start rises a
// fifth, Stop falls a fifth, Error falls a minor third in a lower register.
// Start must end within START_CUE_HEAD_SAMPLES in main/recording-session.ts.
const NOTES: Record<RecordingCue, Array<{ hz: number; at: number; seconds: number }>> = {
  start: [{ hz: 659.25, at: 0, seconds: 0.17 }, { hz: 987.77, at: 0.07, seconds: 0.17 }],
  stop: [{ hz: 987.77, at: 0, seconds: 0.24 }, { hz: 659.25, at: 0.08, seconds: 0.24 }],
  error: [{ hz: 392, at: 0, seconds: 0.28 }, { hz: 329.63, at: 0.12, seconds: 0.28 }],
};
const OVERTONES = [{ ratio: 1, level: 1 }, { ratio: 2, level: 0.3 }, { ratio: 3, level: 0.08 }];
const PEAK_GAIN = 0.07;
const ATTACK_SECONDS = 0.012;
const SILENT_GAIN = 0.0001;

let context: AudioContext | null = null;
let sounding = 0;

/** Plays a cue; the context is suspended whenever nothing sounds. Never throws. */
export function playRecordingCue(cue: RecordingCue): void {
  try {
    context ??= new AudioContext({ latencyHint: 'interactive' });
    const ctx = context;
    void ctx.resume().catch(() => undefined);
    const now = ctx.currentTime + 0.01;
    for (const { hz, at, seconds } of NOTES[cue]) {
      for (const { ratio, level } of OVERTONES) {
        const start = now + at;
        const end = start + seconds / ratio;
        const oscillator = new OscillatorNode(ctx, { frequency: hz * ratio });
        const gain = new GainNode(ctx, { gain: SILENT_GAIN });
        gain.gain.setValueAtTime(SILENT_GAIN, start);
        gain.gain.exponentialRampToValueAtTime(PEAK_GAIN * level, start + ATTACK_SECONDS);
        gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, end);
        oscillator.connect(gain).connect(ctx.destination);
        sounding += 1;
        oscillator.onended = () => {
          gain.disconnect();
          if (--sounding === 0) void ctx.suspend().catch(() => undefined);
        };
        oscillator.start(start);
        oscillator.stop(end);
      }
    }
  } catch (error) {
    console.warn('Recording cue could not play:', error);
  }
}
