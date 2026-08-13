import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SAMPLE_RATE_HZ = 16_000;
const LEADING_SILENCE_MS = 500;
const CHUNK_SAMPLES = 4_096;
const UTTERANCE = 'Shuddhalekhan measures speech latency with a fixed audio sample.';
const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'canonical-utterance-v1.pcm');

export interface PcmPlaybackChunk {
  index: number;
  dueMs: number;
  pcm: Buffer;
}

export function buildPcmPlaybackPlan(
  pcm: Buffer,
  options: { sampleRateHz: number; chunkSamples: number; leadingSilenceMs: number },
): { speechOnsetMs: number; chunks: PcmPlaybackChunk[] } {
  const bytesPerChunk = options.chunkSamples * 2;
  const chunkIntervalMs = (options.chunkSamples / options.sampleRateHz) * 1_000;
  const chunks: PcmPlaybackChunk[] = [];

  for (let offset = 0, index = 0; offset < pcm.byteLength; offset += bytesPerChunk, index += 1) {
    chunks.push({
      index,
      dueMs: index * chunkIntervalMs,
      pcm: pcm.subarray(offset, Math.min(offset + bytesPerChunk, pcm.byteLength)),
    });
  }

  return { speechOnsetMs: options.leadingSilenceMs, chunks };
}

export function generateCanonicalPcmFixture(): {
  pcm: Buffer;
  sha256: string;
  leadingSilenceMs: number;
  speechDurationMs: number;
} {
  const pcm = readFileSync(FIXTURE_PATH);
  const totalDurationMs = (pcm.byteLength / 2 / SAMPLE_RATE_HZ) * 1_000;
  return {
    pcm,
    sha256: createHash('sha256').update(pcm).digest('hex'),
    leadingSilenceMs: LEADING_SILENCE_MS,
    speechDurationMs: totalDurationMs - LEADING_SILENCE_MS,
  };
}

function synthesizeCanonicalPcm(): Buffer {
  const filter = [
    `flite=text='${UTTERANCE}':voice=slt`,
    `adelay=${LEADING_SILENCE_MS}`,
    `aresample=${SAMPLE_RATE_HZ}`,
    'aformat=sample_fmts=s16:channel_layouts=mono',
  ].join(',');
  const result = Bun.spawnSync([
    'ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', filter,
    '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1',
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg speech synthesis failed: ${result.stderr.toString()}`);
  }
  return Buffer.from(result.stdout);
}

if (import.meta.main) {
  if (!process.argv.includes('--regenerate')) {
    throw new Error('Pass --regenerate to intentionally replace the pinned speech fixture.');
  }
  const pcm = synthesizeCanonicalPcm();
  writeFileSync(FIXTURE_PATH, pcm);
  const fixture = generateCanonicalPcmFixture();
  console.log(JSON.stringify({
    path: FIXTURE_PATH,
    bytes: fixture.pcm.byteLength,
    sha256: fixture.sha256,
    utterance: UTTERANCE,
    leadingSilenceMs: fixture.leadingSilenceMs,
    speechDurationMs: fixture.speechDurationMs,
    chunkSamples: CHUNK_SAMPLES,
    chunkIntervalMs: (CHUNK_SAMPLES / SAMPLE_RATE_HZ) * 1_000,
  }, null, 2));
}
