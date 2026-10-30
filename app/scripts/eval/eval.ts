// Verification loop harness, model layer.
//   HF_TOKEN=hf_... bun scripts/eval/eval.ts fetch      # download/verify the hash-locked Svarah dev sample
//   bun scripts/eval/eval.ts --set dev|holdout --layer model [--latency] [--baseline f] [--out f]
// Without --latency only accuracy runs (~1 min): handy while iterating, but it can never pass, since latency is unmeasured.
// Exit code 1 when a --baseline is given and the acceptance rule fails.
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { cpus } from 'os';
import { dirname, join, resolve } from 'path';
import { parseArgs } from 'util';
import { OfflineRecognizer } from 'sherpa-onnx-node';
import { MANAGED_LOCAL_MODEL, managedLocalRecognizerConfig } from '../../src/main/managed-local-model';
import { getManagedLocalThreadLimits } from '../../src/main/managed-local-threads';
import { decodePcm16Wave } from '../../src/main/managed-local-wave';
import { accept, scoreClip, totals, type Result } from './score';

type Clip = { id: string; file: string; sha256: string; text: string };

const DATA_DIR = resolve(import.meta.dir, '../../eval-data/svarah');
const LOCK = join(import.meta.dir, 'dev-set.json');
const SAMPLE_SIZE = 200;
const SVARAH_ROWS = 6656;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** GET that waits out Hugging Face's 429 rate limit and transient 5xx errors. */
async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { headers });
    if ((response.status !== 429 && response.status < 500) || attempt === 10) return response;
    const waitS = Number(response.headers.get('retry-after')) || 30;
    console.error(`rate limited, waiting ${waitS}s`);
    await Bun.sleep(waitS * 1000);
  }
}

async function fetchDevSet(): Promise<void> {
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error('Set HF_TOKEN to a Hugging Face token that can read the gated ai4bharat/Svarah dataset.');
  const auth = { Authorization: `Bearer ${token}` };
  const locked = new Map<string, Clip>(
    existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')).map((clip: Clip) => [clip.id, clip]) : [],
  );
  mkdirSync(DATA_DIR, { recursive: true });

  const rows = sampleRows();
  for (const [index, row] of rows.entries()) {
    const file = `${row}.wav`;
    const path = join(DATA_DIR, file);
    const lockedClip = locked.get(String(row));
    if (lockedClip && existsSync(path) && sha256(readFileSync(path)) === lockedClip.sha256) continue;
    const url = `https://datasets-server.huggingface.co/rows?dataset=ai4bharat/Svarah&config=default&split=test&offset=${row}&length=1`;
    const response = await get(url, auth);
    if (!response.ok) throw new Error(`Row ${row}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    const { rows: [{ row: data }] } = await response.json() as {
      rows: [{ row: { text: string; audio_filepath: [{ src: string }] } }];
    };
    const audioResponse = await get(data.audio_filepath[0].src);
    if (!audioResponse.ok) throw new Error(`Row ${row} audio: ${audioResponse.status}`);
    const audio = new Uint8Array(await audioResponse.arrayBuffer());
    decodePcm16Wave(audio.buffer); // fail now, not mid-eval, if the viewer serves something other than PCM16 WAV
    const hash = sha256(audio);
    if (lockedClip && hash !== lockedClip.sha256) throw new Error(`Row ${row} audio changed upstream; the dev set is no longer frozen.`);
    writeFileSync(path, audio);
    locked.set(String(row), { id: String(row), file, sha256: hash, text: lockedClip?.text ?? data.text });
    // Saved per clip so a rate-limited or interrupted fetch resumes instead of starting over.
    const clips = [...locked.values()].sort((a, b) => Number(a.id) - Number(b.id));
    // Temp file + rename, so a kill mid-write can't truncate the lock and lose the saved references.
    writeFileSync(`${LOCK}.tmp`, `${JSON.stringify(clips, null, 1)}\n`);
    renameSync(`${LOCK}.tmp`, LOCK);
    console.error(`${index + 1}/${rows.length} ${file}`);
  }
}

/** The same 200 rows on every machine: rank all rows by a fixed hash and take the top SAMPLE_SIZE. */
function sampleRows(): number[] {
  // ponytail: plain row sample; Svarah has no speaker id to stratify on.
  return Array.from({ length: SVARAH_ROWS }, (_, row) => ({ row, rank: sha256(new TextEncoder().encode(`svarah-${row}`)) }))
    .sort((a, b) => a.rank.localeCompare(b.rank))
    .slice(0, SAMPLE_SIZE)
    .map(({ row }) => row)
    .sort((a, b) => a - b);
}

function loadSet(set: string): { dir: string; clips: Clip[] } {
  if (set === 'dev') return { dir: DATA_DIR, clips: JSON.parse(readFileSync(LOCK, 'utf8')) };
  if (set === 'holdout') {
    // Lives outside the repo: manifest.json is [{ id, file, sha256, text }] next to the WAVs.
    const dir = process.env.SHUDDHALEKHAN_HOLDOUT_DIR;
    if (!dir) throw new Error('Set SHUDDHALEKHAN_HOLDOUT_DIR to the held-out recordings folder.');
    return { dir, clips: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) };
  }
  throw new Error(`Unknown set "${set}". Use dev or holdout.`);
}

const LATENCY_CLIPS = 40;
const LATENCY_ROUNDS = 20;

async function runModelLayer(set: string, measureLatency: boolean): Promise<Result> {
  const { dir, clips } = loadSet(set);
  // Verify every hash up front, but decode on demand: holding all audio would inflate the RAM guardrail.
  const sizes = clips.map((clip) => {
    const bytes = readFileSync(join(dir, clip.file));
    if (sha256(bytes) !== clip.sha256) throw new Error(`${set} clip does not match its locked hash.`);
    return bytes.byteLength;
  });
  const load = (index: number) => {
    const bytes = readFileSync(join(dir, clips[index].file));
    return decodePcm16Wave(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const fingerprint = sha256(new TextEncoder().encode(
    // CRLF-normalized so an autocrlf checkout doesn't invalidate the committed baseline.
    readFileSync(join(import.meta.dir, 'score.ts'), 'utf8').replaceAll('\r\n', '\n') + JSON.stringify(clips.map(({ id, sha256, text }) => [id, sha256, text])),
  ));
  const modelPath = process.env.SHUDDHALEKHAN_MODEL_DIR
    ?? join(process.env.APPDATA ?? '', 'Shuddhalekhan', 'models', `${MANAGED_LOCAL_MODEL.id}-${MANAGED_LOCAL_MODEL.version}`);
  // ponytail: app default thread count; a user-set managedLocalThreads value is not read here.
  const threads = getManagedLocalThreadLimits().defaultThreads;

  const decode = async (wave: { samples: Float32Array; sampleRate: number }) => {
    const stream = recognizer.createStream();
    stream.acceptWaveform(wave);
    return (await recognizer.decodeAsync(stream)).text;
  };
  const coldStarted = performance.now();
  const recognizer = await OfflineRecognizer.createAsync(managedLocalRecognizerConfig(modelPath, threads));
  await decode(load(0));
  const coldStartMs = performance.now() - coldStarted;

  // Accuracy: greedy decoding is deterministic, so one pass gives the exact transcripts.
  const cpuStart = process.cpuUsage();
  const texts: string[] = [];
  for (let index = 0; index < clips.length; index++) texts.push(await decode(load(index)));
  const cpu = process.cpuUsage(cpuStart);

  // Latency: clips at evenly spaced length ranks (shortest and longest included), each decoded
  // LATENCY_ROUNDS times in a fresh random order every round.
  const latencies = new Map<number, number[]>();
  if (measureLatency) {
    const byLength = sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size);
    const count = Math.min(LATENCY_CLIPS, byLength.length);
    const ranks = new Set(Array.from({ length: count }, (_, i) => Math.round((i * (byLength.length - 1)) / Math.max(1, count - 1))));
    const subset = [...ranks].map((rank) => ({ index: byLength[rank].index, wave: load(byLength[rank].index) }));
    for (const { index } of subset) latencies.set(index, []);
    for (let round = 0; round < LATENCY_ROUNDS; round++) {
      for (const { index, wave } of subset.toSorted(() => Math.random() - 0.5)) {
        const started = performance.now();
        await decode(wave);
        latencies.get(index)!.push(performance.now() - started);
      }
    }
  }

  return {
    set,
    layer: 'model',
    fingerprint,
    // Hypotheses ride along so a regression can be read, not just counted.
    clips: clips.map((clip, index) => ({ ...scoreClip(clip.id, clip.text, texts[index], latencies.get(index)), hypothesis: texts[index] })),
    // maxRSS is the process high-water mark in KiB, covering model load and every decode.
    run: { coldStartMs, peakRssMb: process.resourceUsage().maxRSS / 1024, cpuMsPerClip: (cpu.user + cpu.system) / 1000 / clips.length },
  };
}

/** Context for reading performance numbers; not part of the verdict. */
const machine = () => ({
  threads: getManagedLocalThreadLimits().defaultThreads,
  runtime: `bun ${Bun.version}`,
  cpu: cpus()[0]?.model,
  platform: `${process.platform} ${process.arch}`,
});

async function main(): Promise<void> {
  if (process.argv[2] === 'fetch') return fetchDevSet();
  const { values } = parseArgs({
    options: {
      set: { type: 'string', default: 'dev' },
      layer: { type: 'string', default: 'model' },
      baseline: { type: 'string' },
      out: { type: 'string' },
      latency: { type: 'boolean', default: false },
    },
  });
  // ponytail: the end-to-end layer (VB-Cable + real hotkey) needs the rig; add it when the rig exists.
  if (values.layer !== 'model') throw new Error('Only --layer model exists so far.');

  // Held-out transcripts must never land in the repo, so their output path isn't configurable.
  if (values.set === 'holdout' && values.out) throw new Error('--out is not allowed for the holdout set.');

  const result = await runModelLayer(values.set, values.latency);
  const verdict = values.baseline ? accept(result, JSON.parse(readFileSync(values.baseline, 'utf8'))) : null;
  const out = values.set === 'holdout'
    ? join(process.env.SHUDDHALEKHAN_HOLDOUT_DIR!, 'last-run.json')
    : values.out ?? resolve(import.meta.dir, '../../eval-data/last-run-dev.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ ...result, machine: machine(), totals: totals(result), verdict }, null, 1)}\n`);

  // Held-out runs report only pass/fail and totals; per-clip detail stays in the holdout folder.
  const report = values.set === 'holdout'
    ? { pass: verdict?.pass ?? null, totals: totals(result) }
    : { totals: totals(result), verdict };
  console.log(JSON.stringify(report, null, 2));
  if (verdict && !verdict.pass) process.exitCode = 1;
}

await main();
