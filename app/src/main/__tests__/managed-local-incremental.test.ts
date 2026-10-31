import { describe, expect, it } from 'bun:test';
import { createIncrementalDecoder } from '../managed-local-incremental';

const RATE = 16_000;
const tone = (ms: number) => Float32Array.from({ length: RATE * ms / 1000 }, (_, i) => 0.3 * Math.sin(i / 5));
const quiet = (ms: number) => new Float32Array(RATE * ms / 1000);

function feed(decoder: ReturnType<typeof createIncrementalDecoder>, parts: Float32Array[]) {
  // 512-sample packets, as the capture worklet delivers them.
  for (const part of parts) for (let at = 0; at < part.length; at += 512) decoder.push(part.subarray(at, at + 512));
}

describe('incremental decoding', () => {
  it('uses the decode started at the final pause instead of decoding again on stop', async () => {
    const decoded: number[] = [];
    const decoder = createIncrementalDecoder(async samples => { decoded.push(samples.length); return 'hello'; }, RATE);
    feed(decoder, [tone(1000), quiet(600)]);

    expect(await decoder.finish()).toBe('hello');
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toBeLessThan(RATE * 1.6);
  });

  it('decodes the whole recording when speech follows the last pause', async () => {
    const decoded: number[] = [];
    const decoder = createIncrementalDecoder(async samples => { decoded.push(samples.length); return 'hello again'; }, RATE);
    feed(decoder, [tone(1000), quiet(600), tone(500)]);

    expect(await decoder.finish()).toBe('hello again');
    expect(decoded.at(-1)).toBe(RATE * 2.1);
  });
});
