// AudioWorklet half of audio-capture.ts. Runs on the audio thread. Idle, it
// posts nothing and keeps only the last `processorOptions.preRollFrames` of
// input in a ring. {type:'start', preRollFrames, pressFrame} answers
// {type:'started', late} with up to that many of the newest ring frames heard before
// `pressFrame` (the audio clock at the press); the `late` newer ones open the capture.
// It clears the ring and starts capturing: mono input is batched (~20 ms per message) and posted to the
// renderer. Each posted message with samples spends one credit; the renderer returns it
// ({type:'credit'}) only once main has written that batch to the spool. With no
// credit left, a stalled renderer or main would otherwise queue audio without
// bound, so the worklet ends for good and posts {type:'overflow'} instead. On
// {type:'stop'} it flushes the partial batch, acknowledges with
// {type:'stopped'}, and goes idle; port order guarantees every audio message
// precedes that ack.
const { AudioWorkletProcessor, registerProcessor, sampleRate } = globalThis;
const BATCH_FRAMES = Math.max(128, Math.round(sampleRate / 50));
/** ~5 s of 20 ms batches awaiting main's write acknowledgement. */
const MAX_OUTSTANDING_BATCHES = 250;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.batch = new Float32Array(BATCH_FRAMES);
    this.filled = 0;
    this.credits = MAX_OUTSTANDING_BATCHES;
    this.ring = new Float32Array(options?.processorOptions?.preRollFrames ?? 0);
    this.ringEnd = 0;
    this.ringFilled = 0;
    this.capturing = false;
    this.overflowed = false;
    this.port.onmessage = (event) => {
      const type = event.data?.type;
      if (type === 'credit') {
        this.credits += 1;
        return;
      }
      if (this.overflowed) return;
      if (type === 'start' && !this.capturing) {
        this.capturing = true;
        const ring = this.takeRing(event.data.preRollFrames);
        // Frames heard after the press are the recording's own audio, so they go out as capture, not pre-roll.
        const { pressFrame } = event.data;
        const late = Number.isFinite(pressFrame) ? Math.min(ring.length, Math.max(0, globalThis.currentFrame - pressFrame)) : 0;
        const early = ring.length - late;
        const samples = ring.slice(0, early);
        this.credits = MAX_OUTSTANDING_BATCHES - (early > 0 ? 1 : 0);
        this.port.postMessage({ type: 'started', samples, late }, [samples.buffer]);
        this.capture(ring.subarray(early));
        return;
      }
      if (type !== 'stop' || !this.capturing || !this.flush()) return;
      this.capturing = false;
      this.port.postMessage({ type: 'stopped' });
    };
  }

  /** The newest `frames` ring frames, oldest first; empties the ring so no frame is handed out twice. */
  takeRing(frames) {
    const { ring } = this;
    const count = Math.max(0, Math.min(frames, this.ringFilled));
    const samples = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      samples[index] = ring[(this.ringEnd - count + index + ring.length) % ring.length];
    }
    ring.fill(0);
    this.ringFilled = 0;
    return samples;
  }

  /** False once out of credits: capture is over and overflow has been reported. */
  flush() {
    if (this.filled === 0) return true;
    if (this.credits === 0) {
      this.overflowed = true;
      this.port.postMessage({ type: 'overflow' });
      return false;
    }
    this.credits -= 1;
    const samples = this.batch.slice(0, this.filled);
    this.filled = 0;
    this.port.postMessage({ type: 'audio', samples }, [samples.buffer]);
    return true;
  }

  process(inputs) {
    if (this.overflowed) return false;
    const mono = inputs[0]?.[0];
    if (!mono) return true;
    if (!this.capturing) {
      const { ring } = this;
      for (let index = Math.max(0, mono.length - ring.length); index < mono.length; index += 1) {
        ring[this.ringEnd] = mono[index];
        this.ringEnd = (this.ringEnd + 1) % ring.length;
      }
      this.ringFilled = Math.min(ring.length, this.ringFilled + mono.length);
      return true;
    }
    return this.capture(mono);
  }

  /** Batches capture frames; false once overflow ended capture. */
  capture(mono) {
    let offset = 0;
    while (offset < mono.length) {
      const count = Math.min(mono.length - offset, BATCH_FRAMES - this.filled);
      this.batch.set(mono.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === BATCH_FRAMES && !this.flush()) return false;
    }
    return true;
  }
}

registerProcessor('shuddhalekhan-capture', CaptureProcessor);
