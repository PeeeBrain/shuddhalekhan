/**
 * Decodes while the user is still speaking, so stopping waits for little or no recognition.
 *
 * When speech pauses, everything recorded so far is decoded speculatively. If the recording ends
 * without more speech, that result is the transcript and nothing is left to decode. Speech after the
 * pause discards the speculation. Decodes run one at a time.
 */
const SPECULATE_AFTER_MS = 240;
const FRAME_MS = 20;
/** A frame is quiet below this many dB under the loudest frame so far. */
const QUIET_DB = 30;
// Digital silence and near-silent noise never count as speech, however quiet the recording is.
const ABSOLUTE_FLOOR = 0.001;

export function createIncrementalDecoder(decode: (samples: Float32Array) => Promise<string>, sampleRate: number) {
  const frame = Math.round(sampleRate * FRAME_MS / 1000);
  const quietRatio = 10 ** (-QUIET_DB / 20);
  const speculateFrames = Math.ceil(SPECULATE_AFTER_MS / FRAME_MS);

  let audio = new Float32Array(sampleRate * 8);
  let length = 0;
  let analyzed = 0;
  let peak = 0;
  let quietFrames = 0;
  let heardSpeech = false;
  let speculative: Promise<string> | null = null;
  let speculation = 0;
  let queue: Promise<unknown> = Promise.resolve();

  /** Decodes audio[0, end) after earlier decodes, unless speech has made a queued speculation stale. */
  const enqueue = (end: number, stale = () => false) => {
    const text = queue.then(() => stale() ? '' : decode(audio.slice(0, end)));
    queue = text.catch(() => undefined);
    return text;
  };
  const isSpeech = (start: number, end: number) => {
    let energy = 0;
    for (let i = start; i < end; i++) energy += audio[i] * audio[i];
    const rms = Math.sqrt(energy / (end - start));
    return rms >= ABSOLUTE_FLOOR && rms >= peak * quietRatio;
  };

  return {
    push(samples: Float32Array): void {
      if (length + samples.length > audio.length) {
        const grown = new Float32Array(Math.max(audio.length * 2, length + samples.length));
        grown.set(audio.subarray(0, length));
        audio = grown;
      }
      audio.set(samples, length);
      length += samples.length;
      for (; analyzed + frame <= length; analyzed += frame) {
        let energy = 0;
        for (let i = analyzed; i < analyzed + frame; i++) energy += audio[i] * audio[i];
        peak = Math.max(peak, Math.sqrt(energy / frame));
        if (isSpeech(analyzed, analyzed + frame)) {
          heardSpeech = true;
          quietFrames = 0;
          if (speculative) speculation++;
          speculative = null;
        } else if (++quietFrames === speculateFrames && heardSpeech) {
          const id = ++speculation;
          speculative = enqueue(analyzed + frame, () => id !== speculation);
        }
      }
    },
    /** Resolves to the transcript of everything pushed. */
    finish(): Promise<string> {
      // A remainder shorter than a frame can still hold the start of a word.
      if (speculative && !(length > analyzed && isSpeech(analyzed, length))) return speculative;
      return enqueue(length);
    },
  };
}
