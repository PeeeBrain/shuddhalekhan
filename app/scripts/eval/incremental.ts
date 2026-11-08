// Chunk-fed incremental decoding eval: decoded work, stop latency and boundary accuracy for a candidate
// incremental decoder, against one whole-recording decode of the same audio by the same model.
//   bun scripts/eval/incremental.ts --manifest <clips.json> --model parakeet|granite [--audio dir] [--noise rms] [--speed n]
//     [--decoder file]   # a module exporting createIncrementalDecoder(decode, sampleRate, model) to compare
// Without --decoder it measures production: the whole recording decoded once on stop.
// The manifest is [{ id, file, text }] (dev-set.json and holdout manifests both fit). Clips are joined with
// pauses into long recordings and fed in real time as 512-sample packets, as the capture worklet sends them.
// Model files come from SHUDDHALEKHAN_MODEL_DIR or the app's installed models folder. Not part of `bun test`.
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { parseArgs } from 'util';
import { z } from 'zod';
import { createLocalRecognizer } from '../../src/main/managed-local-recognizer';
import { decodeManagedLocal } from '../../src/main/managed-local-decode';
import { getManagedLocalThreadLimits } from '../../src/main/managed-local-threads';
import { decodePcm16Wave } from '../../src/main/managed-local-wave';
import { align, normalize } from './score';
import { installedModelPath } from './installed-model-path';

const RATE = 16_000;
const PACKET = 512;
const PAUSES_MS = [300, 500, 800, 1200, 2000];
const modelSchema = z.enum(['parakeet', 'granite']);
const MODEL_DIRS = {
  parakeet: 'parakeet-unified-en-0.6b-int8-1',
  granite: 'granite-470m-q4-1',
} satisfies Record<z.infer<typeof modelSchema>, string>;
const clipsSchema = z.array(z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  text: z.string().min(1),
})).min(1);

const { values } = parseArgs({ options: {
  manifest: { type: 'string' }, audio: { type: 'string' }, model: { type: 'string', default: 'parakeet' },
  noise: { type: 'string', default: '0' }, speed: { type: 'string', default: '1' }, decoder: { type: 'string' },
} });
const numericOption = z.string().trim().min(1).pipe(z.coerce.number().finite());
const {
  manifest,
  audio: audioOption,
  model,
  noise,
  speed,
  decoder: decoderPath,
} = z.object({
  manifest: z.string().trim().min(1, 'Pass --manifest with [{ id, file, text }] clips.'),
  audio: z.string().trim().min(1).optional(),
  model: modelSchema,
  noise: numericOption.pipe(z.number().nonnegative()),
  speed: numericOption.pipe(z.number().positive()),
  decoder: z.string().trim().min(1).optional(),
}).parse(values);
const manifestData: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
const clips = clipsSchema.parse(manifestData);

type CreateDecoder = (decode: (samples: Float32Array) => Promise<string>, sampleRate: number, model: 'parakeet' | 'granite')
  => { push(samples: Float32Array): void; finish(): Promise<string> };
const wholeRecording: CreateDecoder = decode => {
  const parts: Float32Array[] = [];
  return {
    push: samples => { parts.push(samples); },
    finish: () => {
      const audio = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
      let at = 0;
      for (const part of parts) { audio.set(part, at); at += part.length; }
      return decode(audio);
    },
  };
};
const createIncrementalDecoder: CreateDecoder = decoderPath
  ? (await import(resolve(decoderPath))).createIncrementalDecoder : wholeRecording;
const modelPath = installedModelPath(MODEL_DIRS[model]);
const audioDir = audioOption ?? dirname(manifest);

const load = (file: string) => {
  const bytes = readFileSync(join(audioDir, file));
  return decodePcm16Wave(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).samples;
};
const silence = (ms: number) => new Float32Array(RATE * ms / 1000);

/** Clips joined by cycling pauses; `quietEvery` scales every nth clip by 1/30 to model a quiet speaker. */
function compose(picked: typeof clips, quietEvery = 0) {
  const parts: Float32Array[] = [silence(300)];
  picked.forEach((clip, i) => {
    const samples = load(clip.file);
    parts.push(quietEvery && i % quietEvery === quietEvery - 1 ? samples.map(sample => sample / 30) : samples);
    parts.push(silence(i === picked.length - 1 ? 600 : PAUSES_MS[i % PAUSES_MS.length]));
  });
  const audio = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { audio.set(part, at); at += part.length; }
  // Deterministic uniform noise with the requested RMS (uniform on [-a, a] has RMS a/√3).
  let seed = 1;
  const amplitude = noise * Math.sqrt(3);
  if (noise) for (let i = 0; i < audio.length; i++) {
    seed = (seed * 1_103_515_245 + 12_345) >>> 0;
    audio[i] += amplitude * (seed / 2 ** 31 - 1);
  }
  return { audio, text: picked.map(clip => clip.text).join(' ') };
}

const threads = getManagedLocalThreadLimits().defaultThreads;
const recognizer = await createLocalRecognizer({ model, backend: 'cpu', modelPath }, threads);
await decodeManagedLocal(recognizer, { samples: silence(1000), sampleRate: RATE });

const wer = (reference: string, hypothesis: string) => {
  const ref = normalize(reference);
  return align(ref, normalize(hypothesis)).errors / Math.max(1, ref.length);
};
const rawDiff = (a: string, b: string) => align(a.trim().split(/\s+/), b.trim().split(/\s+/)).errors;

const recordings = [
  ...clips.slice(0, 5).map(clip => ({ name: `short-${clip.id}`, ...compose([clip]) })),
  { name: 'long', ...compose(clips) },
  { name: 'long-quiet', ...compose(clips, 3) },
];
const rows = [];
for (const recording of recordings) {
  const wholeStarted = performance.now();
  const whole = await decodeManagedLocal(recognizer, { samples: recording.audio, sampleRate: RATE });
  const wholeMs = performance.now() - wholeStarted;

  let decodedSamples = 0;
  let calls = 0;
  const decoder = createIncrementalDecoder(samples => {
    calls++;
    decodedSamples += samples.length;
    return decodeManagedLocal(recognizer, { samples, sampleRate: RATE });
  }, RATE, model);
  const started = performance.now();
  for (let at = 0; at < recording.audio.length; at += PACKET) {
    const due = started + (at / RATE) * 1000 / speed;
    if (due > performance.now()) await Bun.sleep(due - performance.now());
    decoder.push(recording.audio.slice(at, at + PACKET));
  }
  const stopped = performance.now();
  const text = await decoder.finish();
  const row = {
    name: recording.name,
    audioS: +(recording.audio.length / RATE).toFixed(1),
    calls,
    decodedS: +(decodedSamples / RATE).toFixed(1),
    stopMs: Math.round(performance.now() - stopped),
    wholeDecodeMs: Math.round(wholeMs),
    wer: +wer(recording.text, text).toFixed(4),
    wholeWer: +wer(recording.text, whole).toFixed(4),
    rawTokenDiffVsWhole: rawDiff(whole, text),
  };
  rows.push(row);
  console.error(JSON.stringify(row));
}
console.log(JSON.stringify({ model, threads, noise, speed, rows }, null, 1));
