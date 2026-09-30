// Research runner: uses the installed model without changing app settings or audio.
// bun app/scripts/parakeet-experiment.ts MODEL MANIFEST OUTPUT quality|speed THREADS [PROVIDER]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { OfflineRecognizer, version, onnxruntimeVersion } from 'sherpa-onnx-node';
import { z } from 'zod';
import { decodePcm16Wave } from '../src/main/managed-local-wave';
import { normalizeTranscript, wordErrorRate } from './transcription-quality';

function pad(samples: Float32Array, rate: number, lead: number, tail: number) {
  const result = new Float32Array(samples.length + Math.round(rate * (lead + tail) / 1000));
  result.set(samples, Math.round(rate * lead / 1000));
  return result;
}

function onset(samples: Float32Array, rate: number) {
  const frame = Math.round(rate * 0.01);
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let sum = 0;
    for (let i = start; i < start + frame; i++) sum += samples[i] ** 2;
    if (Math.sqrt(sum / frame) > 0.008) return start;
  }
  return 0;
}

function gain(samples: Float32Array, factor: number) {
  return samples.map(sample => Math.max(-1, Math.min(1, sample * factor)));
}

if (process.argv.includes('--self-check')) {
  assert.deepEqual([...pad(Float32Array.of(1, 2), 1000, 2, 1)], [0, 0, 1, 2, 0]);
  assert.equal(onset(Float32Array.from([0, 0, 0.1, 0.1]), 100), 2);
  assert.deepEqual([...gain(Float32Array.of(-0.6, 0.2, 0.6), 2)], [-1, Math.fround(0.4), 1]);
  assert.equal(wordErrorRate('open settings', 'open the settings'), 1 / 3);
  console.log('Experiment checks passed');
} else {
  const [model, manifestPath, output, suite, threadArg, providerArg] = z.tuple([
    z.string().min(1), z.string().min(1), z.string().min(1),
    z.enum(['quality', 'speed']), z.coerce.number().int().min(1).max(64),
    z.string().optional(),
  ]).parse(process.argv.slice(2));
  const provider = providerArg ?? 'cpu';
  const manifest = z.array(z.object({
    name: z.string(), file: z.string(), expected: z.string(),
    synthetic: z.boolean().default(false),
  })).min(1).parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const cases = manifest.map(item => {
    const bytes = readFileSync(resolve(dirname(manifestPath), item.file));
    const wave = decodePcm16Wave(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return { ...item, ...wave, sha256: createHash('sha256').update(bytes).digest('hex'),
      onsetMs: onset(wave.samples, wave.sampleRate) / wave.sampleRate * 1000 };
  });
  const loadStarted = performance.now();
  const recognizer = await OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(model, 'encoder.int8.onnx'),
        decoder: join(model, 'decoder.int8.onnx'),
        joiner: join(model, 'joiner.int8.onnx'),
      },
      tokens: join(model, 'tokens.txt'), numThreads: threadArg,
      provider, modelType: 'nemo_transducer', debug: false,
    },
  });
  const loadMs = performance.now() - loadStarted;
  async function decode(samples: Float32Array, sampleRate: number) {
    const started = performance.now();
    const cpuStarted = process.cpuUsage();
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate });
    const result = await recognizer.decodeAsync(stream);
    const cpu = process.cpuUsage(cpuStarted);
    return { text: result.text, ms: performance.now() - started, cpuMs: (cpu.user + cpu.system) / 1000 };
  }
  const firstDecode = await decode(cases[0].samples, cases[0].sampleRate);
  const idleCpuStart = process.cpuUsage();
  const idleStart = performance.now();
  await new Promise(resolve => setTimeout(resolve, 2000));
  const idleCpu = process.cpuUsage(idleCpuStart);
  const idle = { ms: performance.now() - idleStart, cpuMs: (idleCpu.user + idleCpu.system) / 1000 };
  const rows = [];
  if (suite === 'quality') {
    for (const item of cases) {
      const tight = item.samples.slice(Math.round(item.onsetMs * item.sampleRate / 1000));
      const clipped = tight.slice(Math.round(item.sampleRate * 0.16));
      const variants = [
        { name: 'original', samples: item.samples },
        { name: 'original-lead160', samples: pad(item.samples, item.sampleRate, 160, 0) },
        { name: 'original-tail320', samples: pad(item.samples, item.sampleRate, 0, 320) },
        { name: 'tight-onset', samples: tight },
        { name: 'tight-lead80', samples: pad(tight, item.sampleRate, 80, 0) },
        { name: 'tight-lead160', samples: pad(tight, item.sampleRate, 160, 0) },
        { name: 'tight-lead320', samples: pad(tight, item.sampleRate, 320, 0) },
        { name: 'tight-both160', samples: pad(tight, item.sampleRate, 160, 160) },
        { name: 'tight-gain2', samples: gain(tight, 2) },
        { name: 'clipped160', samples: clipped },
        { name: 'clipped160-lead160', samples: pad(clipped, item.sampleRate, 160, 0) },
      ];
      for (const variant of variants) {
        const result = await decode(variant.samples, item.sampleRate);
        rows.push({ case: item.name, synthetic: item.synthetic, variant: variant.name,
          expected: item.expected, onsetMs: item.onsetMs,
          durationMs: variant.samples.length / item.sampleRate * 1000,
          ...result, wer: wordErrorRate(result.text, item.expected),
          firstWordCorrect: normalizeTranscript(result.text).split(' ')[0] === normalizeTranscript(item.expected).split(' ')[0],
        });
      }
      console.log(`Completed ${item.name}`);
    }
  } else {
    for (let warmup = 0; warmup < 2; warmup++) {
      for (const item of cases) await decode(item.samples, item.sampleRate);
    }
    // Alternate traversal to reduce correlation between duration and thermal drift.
    for (let repeat = 0; repeat < 7; repeat++) {
      for (const item of repeat % 2 ? cases.toReversed() : cases) {
        const result = await decode(item.samples, item.sampleRate);
        rows.push({ case: item.name, repeat, durationMs: item.samples.length / item.sampleRate * 1000,
          ...result, wer: wordErrorRate(result.text, item.expected) });
      }
      console.log(`Completed repeat ${repeat + 1}/7 at ${threadArg} threads`);
    }
  }
  writeFileSync(output, JSON.stringify({
    timestamp: new Date().toISOString(), suite, threads: threadArg, provider, loadMs, firstDecode, idle,
    inputs: cases.map(({ name, sha256, samples, sampleRate, synthetic }) => ({
      name, sha256, sampleRate, samples: samples.length, synthetic,
    })),
    environment: { cpu: cpus()[0].model, logicalCpus: cpus().length, availableParallelism: availableParallelism(),
      ramGiB: totalmem() / 2 ** 30, runtime: process.version, bun: process.versions.bun,
      sherpa: version, ort: onnxruntimeVersion, rssMiB: process.memoryUsage().rss / 2 ** 20 },
    rows,
  }, null, 2));
  console.log(`Saved ${rows.length} measurements to ${output}`);
}
