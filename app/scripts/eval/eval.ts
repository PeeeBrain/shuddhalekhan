// Verification loop harness.
//   HF_TOKEN=hf_... bun scripts/eval/eval.ts fetch      # download/verify the hash-locked Svarah dev sample
//   bun scripts/eval/eval.ts --set dev|holdout --layer model [--latency] [--baseline f] [--out f]
//   bun scripts/eval/eval.ts --set dev|holdout --layer e2e [--baseline f] [--out f]
// model: decodes clips directly. Without --latency only accuracy runs (~1 min): handy while iterating, but it
//   can never pass, since latency is unmeasured.
// e2e: drives the running app through VB-Cable and the real hotkey (see e2e-rig.ps1); ~8 min, hands off the keyboard.
// Exit code 1 when a --baseline is given and the acceptance rule fails, or when a paste clobbered the clipboard.
import { createHash } from 'crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'fs';
import { cpus, tmpdir } from 'os';
import { createRequire } from 'module';
import { dirname, join, resolve } from 'path';
import { parseArgs } from 'util';
import { OfflineRecognizer } from 'sherpa-onnx-node';
import { MANAGED_LOCAL_MODEL, managedLocalRecognizerConfig } from '../../src/main/managed-local-model';
import { getManagedLocalThreadLimits } from '../../src/main/managed-local-threads';
import { decodePcm16Wave } from '../../src/main/managed-local-wave';
import { accept, scoreClip, totals, type Result } from './score';
import { modelIdentity, shuffled } from './run-context';

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
// Speech starts this long after the hotkey, cycled per clip, so clipped first words show up in first-3-words.
const LEAD_INS_MS = [0, 150, 300];

/** Loads a set, verifies every clip against its locked hash and returns file sizes plus the run fingerprint. */
function verifiedSet(set: string) {
  const { dir, clips } = loadSet(set);
  const sizes = clips.map((clip) => {
    const bytes = readFileSync(join(dir, clip.file));
    if (sha256(bytes) !== clip.sha256) throw new Error(`${set} clip does not match its locked hash.`);
    return bytes.byteLength;
  });
  const fingerprint = sha256(new TextEncoder().encode(
    // CRLF-normalized so an autocrlf checkout doesn't invalidate the committed baseline.
    readFileSync(join(import.meta.dir, 'score.ts'), 'utf8').replaceAll('\r\n', '\n') + JSON.stringify(clips.map(({ id, sha256, text }) => [id, sha256, text])),
  ));
  return { dir, clips, sizes, fingerprint };
}

/** Indices of LATENCY_CLIPS clips at evenly spaced length ranks, shortest and longest included. */
function lengthSpread(sizes: number[]): number[] {
  const byLength = sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size);
  const count = Math.min(LATENCY_CLIPS, byLength.length);
  const ranks = new Set(Array.from({ length: count }, (_, i) => Math.round((i * (byLength.length - 1)) / Math.max(1, count - 1))));
  return [...ranks].map((rank) => byLength[rank].index);
}

async function runModelLayer(set: string, measureLatency: boolean) {
  // Hashes are verified up front, but audio is decoded on demand: holding it all would inflate the RAM guardrail.
  const { dir, clips, sizes, fingerprint } = verifiedSet(set);
  const load = (index: number) => {
    const bytes = readFileSync(join(dir, clips[index].file));
    return decodePcm16Wave(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const modelPath = process.env.SHUDDHALEKHAN_MODEL_DIR
    ?? join(process.env.APPDATA ?? '', 'Shuddhalekhan', 'models', `${MANAGED_LOCAL_MODEL.id}-${MANAGED_LOCAL_MODEL.version}`);
  // ponytail: app default thread count; a user-set managedLocalThreads value is not read here.
  const threads = getManagedLocalThreadLimits().defaultThreads;
  const model = modelIdentity(modelPath, MANAGED_LOCAL_MODEL.requiredFiles);

  const decode = async (wave: { samples: Float32Array; sampleRate: number }) => {
    const stream = recognizer.createStream();
    stream.acceptWaveform(wave);
    return (await recognizer.decodeAsync(stream)).text;
  };
  // Warm the OS file cache first: otherwise cold start measures disk caching (2.5–7.8 s run to run), not
  // our load path. Read through a small buffer so the warm-up doesn't count towards peak RSS.
  const chunk = Buffer.alloc(4 << 20);
  for (const entry of readdirSync(modelPath, { withFileTypes: true }).filter((entry) => entry.isFile())) {
    const fd = openSync(join(modelPath, entry.name), 'r');
    while (readSync(fd, chunk) > 0);
    closeSync(fd);
  }
  const coldStarted = performance.now();
  const recognizer = await OfflineRecognizer.createAsync(managedLocalRecognizerConfig(modelPath, threads));
  await decode(load(0));
  const coldStartMs = performance.now() - coldStarted;

  // Accuracy: greedy decoding is deterministic, so one pass gives the exact transcripts.
  const cpuStart = process.cpuUsage();
  const texts: string[] = [];
  for (let index = 0; index < clips.length; index++) texts.push(await decode(load(index)));
  const cpu = process.cpuUsage(cpuStart);

  // Latency: the length-spread subset, each clip decoded LATENCY_ROUNDS times in a fresh random order every round.
  const latencies = new Map<number, number[]>();
  if (measureLatency) {
    const subset = lengthSpread(sizes).map((index) => ({ index, wave: load(index) }));
    for (const { index } of subset) latencies.set(index, []);
    for (let round = 0; round < LATENCY_ROUNDS; round++) {
      for (const { index, wave } of shuffled(subset)) {
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
    model,
    // Hypotheses ride along so a regression can be read, not just counted.
    clips: clips.map((clip, index) => ({ ...scoreClip(clip.id, clip.text, texts[index], latencies.get(index)), hypothesis: texts[index] })),
    // maxRSS is the process high-water mark in KiB, covering model load and every decode.
    run: { coldStartMs, peakRssMb: process.resourceUsage().maxRSS / 1024, cpuMsPerClip: (cpu.user + cpu.system) / 1000 / clips.length },
  };
}

type RigRun = {
  Clips: { Id: string; Text: string; StopToPasteMs: number; ClipboardRestored: boolean }[];
  PeakRssMb: number;
  CpuMs: number;
};

/**
 * Real app, real hotkey, real paste: e2e-rig.ps1 plays the length-spread subset into VB-Cable while the
 * running app records it. Latency is hotkey-stop to text-in-box, the delay a user actually waits.
 */
async function runE2eLayer(set: string): Promise<Result> {
  const { dir, clips, sizes, fingerprint } = verifiedSet(set);
  const picked = lengthSpread(sizes);
  const work = mkdtempSync(join(tmpdir(), 'shuddhalekhan-e2e-'));
  const jobs = join(work, 'jobs.json');
  const out = join(work, 'run.json');
  writeFileSync(jobs, JSON.stringify(picked.map((index, i) => ({
    id: clips[index].id,
    path: join(dir, clips[index].file),
    leadInMs: LEAD_INS_MS[i % LEAD_INS_MS.length],
  }))));
  const electronExe: string = createRequire(import.meta.url)('electron');
  const rig = Bun.spawnSync(
    ['powershell', '-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dir, 'e2e-rig.ps1'), jobs, out, electronExe],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if (rig.exitCode !== 0) throw new Error('The e2e rig failed; see its error above.');
  const run = JSON.parse(readFileSync(out, 'utf8')) as RigRun;
  rmSync(work, { recursive: true });

  const references = new Map(clips.map((clip) => [clip.id, clip.text]));
  return {
    set,
    layer: 'e2e',
    fingerprint,
    clips: run.Clips.map((clip) => ({
      ...scoreClip(clip.Id, references.get(clip.Id)!, clip.Text.trim(), clip.StopToPasteMs < 0 ? [] : [clip.StopToPasteMs]),
      hypothesis: clip.Text.trim(),
      clipboardRestored: clip.ClipboardRestored,
    })),
    // Cold start is the model layer's guardrail; the app was already running when this layer started.
    run: { coldStartMs: 0, peakRssMb: run.PeakRssMb, cpuMsPerClip: run.CpuMs / run.Clips.length },
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
  if (values.layer !== 'model' && values.layer !== 'e2e') throw new Error(`Unknown layer "${values.layer}". Use model or e2e.`);

  // Held-out transcripts must never land in the repo, so their output path isn't configurable.
  if (values.set === 'holdout' && values.out) throw new Error('--out is not allowed for the holdout set.');

  const result = values.layer === 'e2e' ? await runE2eLayer(values.set) : await runModelLayer(values.set, values.latency);
  const verdict = values.baseline ? accept(result, JSON.parse(readFileSync(values.baseline, 'utf8'))) : null;
  const out = values.set === 'holdout'
    ? join(process.env.SHUDDHALEKHAN_HOLDOUT_DIR!, `last-run-${values.layer}.json`)
    : values.out ?? resolve(import.meta.dir, `../../eval-data/last-run-${values.set}-${values.layer}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ ...result, machine: machine(), totals: totals(result), verdict }, null, 1)}\n`);

  // Held-out runs report only pass/fail and totals; per-clip detail stays in the holdout folder.
  const report = values.set === 'holdout'
    ? { pass: verdict?.pass ?? null, totals: totals(result) }
    : { totals: totals(result), verdict };
  console.log(JSON.stringify(report, null, 2));
  // A clobbered clipboard is a hard failure, not a statistic.
  const clipboardLost = result.clips.filter((clip) => 'clipboardRestored' in clip && !clip.clipboardRestored).length;
  if (clipboardLost) console.error(`${clipboardLost} clip(s) left the clipboard changed after pasting.`);
  if ((verdict && !verdict.pass) || clipboardLost) process.exitCode = 1;
}

await main();
