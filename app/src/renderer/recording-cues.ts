import type { RecordingCue } from '../types/ipc';

// Original cues synthesized here, so there are no asset files to load or decode:
// short sine notes with a fast attack and a soft decay. Start rises, Stop falls,
// Error is a low double note. Start must stay within START_CUE_HEAD_SAMPLES in
// main/recording-session.ts.
const NOTES: Record<RecordingCue, Array<{ hz: number; at: number }>> = {
  start: [{ hz: 587.33, at: 0 }, { hz: 880, at: 0.06 }],
  stop: [{ hz: 880, at: 0 }, { hz: 587.33, at: 0.06 }],
  error: [{ hz: 311.13, at: 0 }, { hz: 311.13, at: 0.13 }],
};
const NOTE_SECONDS = 0.09;
const PEAK_GAIN = 0.12;
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
    for (const { hz, at } of NOTES[cue]) {
      const start = now + at;
      const oscillator = new OscillatorNode(ctx, { frequency: hz });
      const gain = new GainNode(ctx, { gain: SILENT_GAIN });
      gain.gain.setValueAtTime(SILENT_GAIN, start);
      gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, start + 0.005);
      gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, start + NOTE_SECONDS);
      oscillator.connect(gain).connect(ctx.destination);
      sounding += 1;
      oscillator.onended = () => {
        gain.disconnect();
        if (--sounding === 0) void ctx.suspend().catch(() => undefined);
      };
      oscillator.start(start);
      oscillator.stop(start + NOTE_SECONDS);
    }
  } catch (error) {
    console.warn('Recording cue could not play:', error);
  }
}
