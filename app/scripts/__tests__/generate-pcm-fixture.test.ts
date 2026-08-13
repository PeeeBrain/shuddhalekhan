import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildPcmPlaybackPlan,
  generateCanonicalPcmFixture,
} from '../performance/generate-pcm-fixture';

const manifest = JSON.parse(readFileSync(
  join(import.meta.dir, '..', 'performance', 'fixtures', 'manifest.json'),
  'utf8',
));

describe('generateCanonicalPcmFixture', () => {
  it('produces deterministic PCM with a stable SHA-256', () => {
    const first = generateCanonicalPcmFixture();
    const second = generateCanonicalPcmFixture();

    expect(first.sha256).toBe(second.sha256);
    expect(first.pcm.equals(second.pcm)).toBe(true);
    expect(first.pcm.byteLength).toBeGreaterThan(0);
  });

  it('loads a checksum-pinned spoken utterance rather than a synthetic tone', () => {
    const fixture = generateCanonicalPcmFixture();
    const frameSamples = 400;
    const frameRms: number[] = [];
    for (let offset = fixture.leadingSilenceMs * 16; offset < fixture.pcm.byteLength / 2; offset += frameSamples) {
      let squareSum = 0;
      const end = Math.min(offset + frameSamples, fixture.pcm.byteLength / 2);
      for (let sample = offset; sample < end; sample += 1) {
        const value = fixture.pcm.readInt16LE(sample * 2);
        squareSum += value * value;
      }
      frameRms.push(Math.sqrt(squareSum / (end - offset)));
    }
    const activeFrames = frameRms.filter((value) => value > 100);
    const mean = activeFrames.reduce((sum, value) => sum + value, 0) / activeFrames.length;
    const standardDeviation = Math.sqrt(
      activeFrames.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / activeFrames.length,
    );

    expect(manifest.pcmFixture.source.kind).toBe('flite-tts');
    expect(manifest.pcmFixture.utterance).toBe('Shuddhalekhan measures speech latency with a fixed audio sample.');
    expect(fixture.sha256).toBe(manifest.pcmFixture.sha256);
    expect(activeFrames.length).toBeGreaterThan(20);
    expect(standardDeviation / mean).toBeGreaterThan(0.15);
  });

  it('builds a real-time 4096-sample playback schedule with a known speech onset', () => {
    const fixture = generateCanonicalPcmFixture();
    const plan = buildPcmPlaybackPlan(fixture.pcm, {
      sampleRateHz: manifest.pcmFixture.sampleRateHz,
      chunkSamples: manifest.pcmFixture.chunkSamples,
      leadingSilenceMs: fixture.leadingSilenceMs,
    });

    expect(plan.speechOnsetMs).toBe(500);
    expect(plan.chunks[0]).toMatchObject({ index: 0, dueMs: 0 });
    expect(plan.chunks[1]).toMatchObject({ index: 1, dueMs: 256 });
    expect(plan.chunks[0].pcm.byteLength).toBe(4096 * 2);
    expect(plan.chunks.at(-1)!.pcm.byteLength).toBeLessThanOrEqual(4096 * 2);
    expect(Buffer.concat(plan.chunks.map((chunk) => chunk.pcm))).toEqual(fixture.pcm);
  });
});
