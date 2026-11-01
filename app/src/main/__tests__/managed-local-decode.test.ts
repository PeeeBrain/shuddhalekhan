import { describe, expect, it } from 'bun:test';
import { decodeManagedLocal } from '../managed-local-decode';
import type { OfflineRecognizer, OfflineStream } from 'sherpa-onnx-node';

// Model inference stays in the opt-in eval. This fake records the actual native waveform boundary.
function recognizerBoundary(texts: string[]) {
  const waves: Parameters<OfflineStream['acceptWaveform']>[0][] = [];
  let decodes = 0;
  const recognizer = {
    createStream: () => ({ acceptWaveform: wave => { waves.push(wave); } }),
    decodeAsync: async () => ({ text: texts[decodes++] ?? '', tokens: [], timestamps: [], durations: [], ys_log_probs: [] }),
  } satisfies Pick<OfflineRecognizer, 'createStream' | 'decodeAsync'>;
  return { recognizer, waves };
}

describe('local recognition recovery', () => {
  it('retries a blank voiced decode once with bounded gain and acoustic context, preserving the recording', async () => {
    const { recognizer, waves } = recognizerBoundary(['', 'Recovered speech']);
    const samples = Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i * 0.1) * 0.25);
    const before = samples.slice();
    await decodeManagedLocal(recognizer, { samples, sampleRate: 16_000 });

    expect(waves).toHaveLength(2);
    expect(samples).toEqual(before);
    const retry = waves[1];
    expect(retry.sampleRate).toBe(16_000);
    expect(retry.samples.length).toBe(6720);
    expect(retry.samples.slice(0, 2560).every(sample => sample === 0)).toBe(true);
    expect(retry.samples.slice(-2560).every(sample => sample === 0)).toBe(true);
    expect(retry.samples[2560 + 100]).toBeCloseTo(before[100] * 3.6, 4);
    expect(Math.max(...retry.samples.map(Math.abs))).toBeCloseTo(0.9, 4);
  });

  it('does not retry silence, quiet noise, or an already recognized utterance', async () => {
    for (const [text, amplitude] of [['', 0], ['', 0.00001], ['Keep this exact text.', 0.5]] as const) {
      const { recognizer, waves } = recognizerBoundary([text]);
      const result = await decodeManagedLocal(recognizer, {
        samples: Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i * 0.1) * amplitude),
        sampleRate: 16_000,
      });
      expect(result).toBe(text);
      expect(waves).toHaveLength(1);
    }
  });

  it('does not loop when the recovery decode is also blank', async () => {
    const { recognizer, waves } = recognizerBoundary(['', '']);
    const samples = Float32Array.from({ length: 800 }, (_, i) => Math.sin(i * 0.1) * 0.2);
    expect(await decodeManagedLocal(recognizer, { samples, sampleRate: 8000 })).toBe('');
    expect(waves).toHaveLength(2);
    expect(waves[1].samples.length).toBe(3360);
  });
});
