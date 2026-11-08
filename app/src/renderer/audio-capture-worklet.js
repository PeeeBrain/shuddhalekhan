// AudioWorklet half of audio-capture.ts. Runs on the audio thread: batches mono
// input (~20 ms per message) and posts it to the renderer. Each posted batch
// spends one credit; the renderer returns it ({type:'credit'}) only once main
// has written that batch to the spool. With no credit left, a stalled renderer
// or main would otherwise queue audio without bound, so the worklet stops and
// posts {type:'overflow'} instead. On {type:'stop'} it flushes the partial
// batch and acknowledges with {type:'stopped'}; port order guarantees every
// audio message precedes that ack.
const { AudioWorkletProcessor, registerProcessor, sampleRate } = globalThis;
const BATCH_FRAMES = Math.max(128, Math.round(sampleRate / 50));
/** ~5 s of 20 ms batches awaiting main's write acknowledgement. */
const MAX_OUTSTANDING_BATCHES = 250;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(BATCH_FRAMES);
    this.filled = 0;
    this.credits = MAX_OUTSTANDING_BATCHES;
    this.stopped = false;
    this.port.onmessage = (event) => {
      const type = event.data?.type;
      if (type === 'credit') {
        this.credits += 1;
        return;
      }
      if (type !== 'stop' || this.stopped) return;
      if (!this.flush()) return;
      this.stopped = true;
      this.port.postMessage({ type: 'stopped' });
    };
  }

  /** False once out of credits: capture is over and overflow has been reported. */
  flush() {
    if (this.filled === 0) return true;
    if (this.credits === 0) {
      this.stopped = true;
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
    if (this.stopped) return false;
    const mono = inputs[0]?.[0];
    if (!mono) return true;
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
