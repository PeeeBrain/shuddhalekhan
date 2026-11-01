import type { OfflineRecognizer, OfflineStream } from 'sherpa-onnx-node';

/** Shared by the utility process and eval so both exercise the same recovery path. */
export async function decodeManagedLocal(
  recognizer: Pick<OfflineRecognizer, 'createStream' | 'decodeAsync'>,
  wave: Parameters<OfflineStream['acceptWaveform']>[0],
): Promise<string> {
  const decode = async (input: typeof wave) => {
    const stream = recognizer.createStream();
    stream.acceptWaveform(input);
    return (await recognizer.decodeAsync(stream)).text;
  };
  const text = await decode(wave);
  if (text.trim()) return text;

  let peak = 0;
  for (const sample of wave.samples) peak = Math.max(peak, Math.abs(sample));
  // Do not amplify digital silence or near-silent quantization noise into a second attempt.
  if (peak < 0.001) return text;

  // Parakeet occasionally returns no tokens for speech. Retry only that failure, never rewrite a result.
  const padding = Math.round(wave.sampleRate * 0.16);
  const samples = new Float32Array(wave.samples.length + padding * 2);
  const gain = Math.min(8, 0.9 / peak);
  for (let i = 0; i < wave.samples.length; i++) samples[padding + i] = wave.samples[i] * gain;
  return decode({ samples, sampleRate: wave.sampleRate });
}
