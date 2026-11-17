// Verification loop harness.
//   HF_TOKEN=hf_... bun scripts/eval/eval.ts fetch      # download/verify the hash-locked Svarah dev sample
//   bun scripts/eval/eval.ts --set dev|holdout --layer model [--latency] [--baseline f] [--out f]
//   bun scripts/eval/eval.ts --set dev|holdout --layer e2e [--gain g] [--label l] [--baseline f] [--out f]
//   bun scripts/eval/eval.ts --layer idle --label l [--seconds n] [--out f]
// model: decodes clips directly. Without --latency only accuracy runs (~1 min): handy while iterating, but it
//   can never pass, since latency is unmeasured.
// e2e: drives the running app through VB-Cable and the real hotkey (see e2e-rig.ps1); ~8 min, hands off the keyboard.
//   --gain < 1 plays every clip that much quieter (0.1 = -20 dB) for the quiet-speech case.
// idle: samples the running app's process tree for --seconds (default 60) without touching it.
// Exit code 1 when a --baseline is given and the acceptance rule fails, or when a paste clobbered the clipboard.
//
// Measuring the app (Windows; quit every other Shuddhalekhan, dev or installed: a second launch hands off to it):
//   $env:SHUDDHALEKHAN_PROFILE_DIR = "$PWD\.cache\eval-profile"      # throwaway settings, credentials, models
//   $env:SHUDDHALEKHAN_TIMING_LOG = "$PWD\.cache\eval-timing.jsonl"   # opt-in lifecycle marks, src/main/eval-timing.ts
//   bun run dev            # in that shell; once per profile: microphone CABLE Output, Dictation F2 toggle, install the
//                          # model (or copy %APPDATA%\Shuddhalekhan\models into the profile), device CPU or CUDA
//   bun scripts/eval/eval.ts --layer e2e --label warm-cpu            # same two variables, second shell
// The app must see both variables, and eval.ts reads them too: it refuses to drive a real profile, records the
// profile's provider/model/device, the git build and the machine, and truncates the timing log before the run.
// Each e2e clip reports hotkey->pill (when main sends it, not when it paints), hotkey->capture-ready, release->transcript (raw, before formatting),
// release->paste dispatched (SendInput accepted), release->text observed in the rig's box, and release->clipboard
// restored. Medians need 10 samples and p95 needs 20 (timing.ts). Clip 1 is reported apart as `firstClip`: the
// process's first Dictation, so restart the app before each run and don't dictate in between. The app warms the local model at startup, so first-model load is the model layer's
// coldStartMs (fixed Parakeet on CPU, whatever the profile selects), not this. Raw rig clocks and marks are kept in the output file.
// Resources: `--layer idle --label settings-closed`, then open Settings from the tray and `--label settings-open`. Idle
// reports process-tree CPU, working set, private bytes, and GPU Engine utilization when Windows exposes those
// counters; wakeups need ETW tracing and are not measured. The e2e layer covers Dictation active.
// A/B: build base and head in two worktrees, alternate base/head/base/head runs with the same profile and --out
// files, and compare a head run with --baseline <base run>. The rig saves and restores your clipboard.
// Linux: no rig yet. The marks work unchanged (CLOCK_MONOTONIC). By hand on X11:
// `pactl load-module module-null-sink sink_name=eval` and pick "Monitor of eval" as the microphone, then per clip
// `xdotool key F2; paplay --device=eval clip.wav; xdotool key F2` into a focused editor. X11 pastes through the
// same clipboard transaction; KDE Wayland delivery types through the portal and has no dispatch mark.
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
import { accept, normalize, scoreClip, totals, type Result } from './score';
import { correlate, MIN_SAMPLES_FOR_MEDIAN, MIN_SAMPLES_FOR_TAIL, parseMarks, summarize, type ClipTimings } from './timing';
import { modelIdentity, shuffled } from './run-context';
import { installedModelPath } from './installed-model-path';

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
  const modelPath = installedModelPath(`${MANAGED_LOCAL_MODEL.id}-${MANAGED_LOCAL_MODEL.version}`);
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
  Clips: {
    Id: string; Text: string; StopToPasteMs: number; ClipboardRestored: boolean;
    PressNs: string; ReleaseNs: string; ObservedNs: string | null;
  }[];
  PeakRssMb: number;
  CpuMs: number;
};

/** Runs e2e-rig.ps1 against the running dev Electron (or installed app) and returns its JSON. */
function runRig<T>(args: string[]): T {
  const work = mkdtempSync(join(tmpdir(), 'shuddhalekhan-e2e-'));
  const out = join(work, 'run.json');
  const [jobs, ...extra] = args;
  const electronExe: string = createRequire(import.meta.url)('electron');
  try {
    const rig = Bun.spawnSync(
      ['powershell', '-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dir, 'e2e-rig.ps1'), jobs, out, electronExe, ...extra],
      { stdout: 'inherit', stderr: 'inherit' },
    );
    if (rig.exitCode !== 0) throw new Error('The e2e rig failed; see its error above.');
    return JSON.parse(readFileSync(out, 'utf8')) as T;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The isolated profile the app was started with; the rig never drives a real one. */
function profile() {
  const dir = process.env.SHUDDHALEKHAN_PROFILE_DIR;
  if (!dir) throw new Error('Set SHUDDHALEKHAN_PROFILE_DIR to a throwaway profile, for the app and for eval.ts (see the header).');
  const configPath = join(dir, 'shuddhalekhan-config.json');
  if (!existsSync(configPath)) throw new Error(`No settings in ${dir}: start the app with SHUDDHALEKHAN_PROFILE_DIR set and configure it first.`);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const provider = config.transcription?.activeProvider;
  if (provider === 'managed-local' && config.managedLocal?.devices?.[config.managedLocal.model] !== 'cpu'
    && config.managedLocal?.devices?.[config.managedLocal.model] !== 'cuda') {
    // `auto` may pick CUDA or fall back to CPU, and the result could not say which it measured.
    throw new Error('Set the eval profile\'s local model device to CPU or CUDA, not Auto.');
  }
  return {
    dir,
    provider,
    // Provider ids don't match their settings keys, so keep the whole block rather than guess one.
    providerSettings: config.transcription?.providers ?? null,
    managedLocal: config.managedLocal,
    managedLocalThreads: config.managedLocalThreads ?? null,
    dictationMode: config.dictation?.mode,
    dictationShortcut: config.shortcuts?.dictation,
  };
}

/** Plays every clip `gain` times as loud. Clips are PCM16 (fetch verifies that). */
function scaled(bytes: Buffer, gain: number): Buffer {
  const out = Buffer.from(bytes);
  for (let pos = 12; pos + 8 <= out.length;) {
    const size = out.readUInt32LE(pos + 4);
    if (out.toString('ascii', pos, pos + 4) === 'data') {
      const end = Math.min(out.length, pos + 8 + size) - 1;
      for (let i = pos + 8; i < end; i += 2) out.writeInt16LE(Math.round(out.readInt16LE(i) * gain), i);
      return out;
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error('Clip has no data chunk.');
}

/**
 * Real app, real hotkey, real paste: e2e-rig.ps1 plays the length-spread subset into VB-Cable while the
 * running app records it. Latency is hotkey-stop to text-in-box, the delay a user actually waits.
 */
async function runE2eLayer(set: string, gain: number) {
  const { dir, clips, sizes, fingerprint } = verifiedSet(set);
  const settings = profile();
  const shortcut = settings.dictationShortcut;
  if (shortcut?.binding?.keyCode !== 0x71 || shortcut.binding.modifiers.length || shortcut.activationMode !== 'toggle') {
    throw new Error('The rig presses F2 once to start and once to stop: set Dictation to F2, toggle, in the eval profile.');
  }
  const timingLog = process.env.SHUDDHALEKHAN_TIMING_LOG;
  if (!timingLog) throw new Error('Set SHUDDHALEKHAN_TIMING_LOG for the app and for eval.ts (see the header).');
  mkdirSync(dirname(timingLog), { recursive: true });
  writeFileSync(timingLog, '');

  const picked = lengthSpread(sizes);
  const work = mkdtempSync(join(tmpdir(), 'shuddhalekhan-e2e-jobs-'));
  try {
    const jobs = join(work, 'jobs.json');
    writeFileSync(jobs, JSON.stringify(picked.map((index, i) => {
      let path = join(dir, clips[index].file);
      if (gain !== 1) {
        const quiet = join(work, clips[index].file);
        writeFileSync(quiet, scaled(readFileSync(path), gain));
        path = quiet;
      }
      return { id: clips[index].id, path, leadInMs: LEAD_INS_MS[i % LEAD_INS_MS.length] };
    })));
    const run = runRig<RigRun>([jobs]);

    const marks = parseMarks(readFileSync(timingLog, 'utf8'));
    // No marks means the rig drove some other instance (a second launch hands off to the running app),
    // so this run measured a profile other than the one recorded here.
    if (!marks.length) throw new Error('The app wrote no timing marks: quit every other Shuddhalekhan, then start it with the eval variables.');
    // A clip that timed out may still paste into a later clip's box, so the clips after the first timeout are
    // left out of scores and summaries (the timed-out clip itself counts as a failure). Raw output keeps them all.
    const timedOut = run.Clips.findIndex((clip) => clip.ObservedNs === null);
    const trusted = timedOut < 0 ? run.Clips : run.Clips.slice(0, timedOut + 1);
    const timings = correlate(run.Clips.map((clip) => ({
      id: clip.Id, pressNs: clip.PressNs, releaseNs: clip.ReleaseNs, observedNs: clip.ObservedNs,
    })), marks).slice(0, trusted.length);
    const references = new Map(clips.map((clip) => [clip.id, clip.text]));
    const scored = trusted.map((clip, i) => {
      const hypothesis = clip.Text.trim();
      const reference = references.get(clip.Id)!;
      return {
        ...scoreClip(clip.Id, reference, hypothesis, clip.StopToPasteMs < 0 ? [] : [clip.StopToPasteMs]),
        // The tail of the utterance cut off at the stop hotkey; first-word loss is score.ts's firstThreeWrong.
        lastWordWrong: normalize(reference).at(-1) !== normalize(hypothesis).at(-1),
        hypothesis,
        clipboardRestored: clip.ClipboardRestored,
        timings: timings[i],
      };
    });
    const result: Result = {
      set,
      layer: 'e2e',
      // A quieter fixture is a different experiment; it must never pair with a full-level baseline.
      fingerprint: gain === 1 ? fingerprint : sha256(new TextEncoder().encode(`${fingerprint}:gain=${gain}`)),
      clips: scored,
      // Cold start is the model layer's guardrail; the app was already running when this layer started.
      run: { coldStartMs: 0, peakRssMb: run.PeakRssMb, cpuMsPerClip: run.CpuMs / run.Clips.length },
    };
    // Clip 1 pays for any first-process/first-model work, so it is kept apart from the warm summary.
    const warm = timings.slice(1);
    const timing = {
      firstClip: timings[0] ?? null,
      ...Object.fromEntries((Object.keys(timings[0] ?? {}) as (keyof ClipTimings)[])
        .filter((key) => key !== 'pasteAcceptedEvents')
        .map((key) => [key, summarize(warm.map((clip) => clip[key]))])),
      // Dispatch succeeded but nothing reached the box: the gap between "sent" and "inserted".
      dispatchedNotObserved: timings.filter((clip) => clip.releaseToPasteDispatchMs !== null && clip.releaseToObservedInsertMs === null).length,
      lastWordWrongRate: scored.filter((clip) => clip.lastWordWrong).length / Math.max(1, scored.length),
      excludedAfterTimeout: run.Clips.length - trusted.length,
    };
    // Raw clocks and marks ride along so a paired trial can be re-correlated later.
    return { result, extra: { profile: settings, fixture: { gain, clips: picked.length }, timing, raw: { rig: run, marks } } };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

type IdleRun = {
  Processes: number; Seconds: number; CpuMs: number; WorkingSetMb: number; PrivateMb: number;
  GpuEngineSumPercent: number | null; GpuNote: string | null;
};

function runIdleLayer(seconds: number) {
  const settings = profile();
  const idle = runRig<IdleRun>(['-', '-IdleSeconds', String(seconds)]);
  return {
    profile: settings,
    idle: {
      processes: idle.Processes,
      seconds: idle.Seconds,
      cpuPercentOfOneCore: (idle.CpuMs / (idle.Seconds * 1000)) * 100,
      workingSetMb: idle.WorkingSetMb,
      privateMb: idle.PrivateMb,
      gpuEngineSumPercent: idle.GpuEngineSumPercent,
      gpuNote: idle.GpuNote,
      wakeups: 'not measured: needs ETW tracing (wpr), which this rig does not run',
    },
  };
}

/** The checked-out build, so a result says which code it measured. */
const build = () => ({
  commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
  dirty: Bun.spawnSync(['git', 'status', '--porcelain']).stdout.toString().trim() !== '',
});

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
      gain: { type: 'string', default: '1' },
      label: { type: 'string' },
      seconds: { type: 'string', default: '60' },
    },
  });
  if (!['model', 'e2e', 'idle'].includes(values.layer)) throw new Error(`Unknown layer "${values.layer}". Use model, e2e or idle.`);
  const gain = Number(values.gain);
  if (!(gain > 0 && gain <= 1)) throw new Error('--gain must be in (0, 1].');
  const label = values.label ? `-${values.label.replace(/[^\w.-]/g, '_')}` : '';

  if (values.layer === 'idle') {
    const seconds = Number(values.seconds);
    if (!(seconds >= 5)) throw new Error('--seconds must be at least 5.');
    const idle = { label: values.label ?? null, ...runIdleLayer(seconds), build: build(), machine: machine() };
    const out = values.out ?? resolve(import.meta.dir, `../../eval-data/last-run-idle${label}.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(idle, null, 1)}\n`);
    console.log(JSON.stringify(idle.idle, null, 2));
    return;
  }

  // Held-out transcripts must never land in the repo, so their output path isn't configurable.
  if (values.set === 'holdout' && values.out) throw new Error('--out is not allowed for the holdout set.');

  const { result, extra } = values.layer === 'e2e'
    ? await runE2eLayer(values.set, gain)
    : { result: await runModelLayer(values.set, values.latency), extra: null };
  const baseline = values.baseline ? JSON.parse(readFileSync(values.baseline, 'utf8')) : null;
  // A run cut short at a rig timeout covers fewer clips, so accept() would refuse it; say why and still write it.
  const stopped = extra?.timing.excludedAfterTimeout || baseline?.timing?.excludedAfterTimeout;
  const verdict = !baseline ? null
    : stopped ? { pass: false, reason: 'A run stopped at a rig timeout, so the pair is not comparable.' }
    : accept(result, baseline);
  // score.ts (locked) reports latency quantiles at any count; hold them to timing.ts's sample floor.
  const latencies = result.clips.filter((clip) => clip.latenciesMs.length).length;
  const summary = {
    ...totals(result),
    ...(latencies < MIN_SAMPLES_FOR_MEDIAN && { latencyP50Ms: null }),
    ...(latencies < MIN_SAMPLES_FOR_TAIL && { latencyP95Ms: null }),
  };
  const out = values.set === 'holdout'
    ? join(process.env.SHUDDHALEKHAN_HOLDOUT_DIR!, `last-run-${values.layer}${label}.json`)
    : values.out ?? resolve(import.meta.dir, `../../eval-data/last-run-${values.set}-${values.layer}${label}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({
    ...result, label: values.label ?? null, ...extra, build: build(), machine: machine(), totals: summary, verdict,
  }, null, 1)}\n`);

  // Held-out runs report only pass/fail and totals; per-clip detail stays in the holdout folder.
  const report = values.set === 'holdout'
    ? { pass: verdict?.pass ?? null, totals: summary }
    : { totals: summary, verdict, timing: extra?.timing };
  console.log(JSON.stringify(report, null, 2));
  // A clobbered clipboard is a hard failure, not a statistic.
  const clipboardLost = result.clips.filter((clip) => 'clipboardRestored' in clip && !clip.clipboardRestored).length;
  if (clipboardLost) console.error(`${clipboardLost} clip(s) left the clipboard changed after pasting.`);
  if ((verdict && !verdict.pass) || clipboardLost) process.exitCode = 1;
}

await main();
