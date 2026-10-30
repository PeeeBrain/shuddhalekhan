// Scorer for the verification loop. Read-only to agents (see .claude/settings.json deny rules).

export type ClipScore = {
  id: string;
  words: number;
  errors: number;
  deletions: number;
  insertions: number;
  /** Any of the first three reference words missing or wrong (per clip, not per word). */
  firstThreeWrong: boolean;
  rawWords: number;
  rawErrors: number;
  wrongLanguage: boolean;
  /** Every timed decode of this clip; empty when the run skipped latency. */
  latenciesMs: number[];
};

export type RunStats = { coldStartMs: number; peakRssMb: number; cpuMsPerClip: number };
/** fingerprint covers the scorer source and the references, so a stale baseline can't be compared. */
export type Result = { set: string; layer: string; fingerprint: string; clips: ClipScore[]; run: RunStats };

const FILLERS = new Set(['uh', 'uhh', 'um', 'umm', 'hmm', 'mm', 'ah', 'er', 'erm']);
const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = new Map(Object.entries({ thousand: 1e3, lakh: 1e5, million: 1e6, crore: 1e7, billion: 1e9 }));
const REPEATS = new Map(Object.entries({ double: 2, triple: 3 }));
const DIGITS = /^\d+$/;

// ponytail: explicit British→American pairs; extend the list when a real transcript trips on a missing one.
const SPELLINGS = new Map(
  [
    ['centre', 'center'], ['metre', 'meter'], ['litre', 'liter'], ['theatre', 'theater'], ['fibre', 'fiber'],
    ['colour', 'color'], ['favour', 'favor'], ['flavour', 'flavor'], ['honour', 'honor'], ['labour', 'labor'],
    ['neighbour', 'neighbor'], ['behaviour', 'behavior'], ['humour', 'humor'], ['harbour', 'harbor'],
    ['organise', 'organize'], ['organised', 'organized'], ['organisation', 'organization'], ['realise', 'realize'],
    ['realised', 'realized'], ['recognise', 'recognize'], ['recognised', 'recognized'], ['analyse', 'analyze'],
    ['programme', 'program'], ['travelled', 'traveled'], ['travelling', 'traveling'], ['cancelled', 'canceled'],
    ['jewellery', 'jewelry'], ['defence', 'defense'], ['licence', 'license'], ['grey', 'gray'], ['cheque', 'check'],
    ['tyre', 'tire'], ['catalogue', 'catalog'], ['dialogue', 'dialog'], ['enrol', 'enroll'], ['practise', 'practice'],
  ].flatMap(([uk, us]) => [[uk, us], [`${uk}s`, `${us}s`]]),
);

/**
 * Spoken numbers to digits: "nineteen ninety nine" -> "1999", "three double seven" -> "377",
 * "two lakh fifty thousand" and "2 lakh 50 thousand" -> "250000". Adjacent number groups are
 * concatenated, the way people read out years, phone numbers and PIN codes.
 */
function digitize(words: string[]): string[] {
  const out: string[] = [];
  let total = 0;
  let current = 0;
  let last: 'none' | 'unit' | 'tens' | 'hundred' | 'scale' = 'none';
  const flush = () => {
    if (last !== 'none') out.push(String(total + current));
    total = current = 0;
    last = 'none';
  };
  const continues = () => last === 'hundred' || last === 'scale';
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const unit = UNITS.indexOf(word);
    const tens = TENS.indexOf(word);
    const next = words[i + 1];
    if (REPEATS.has(word) && UNITS.indexOf(next) >= 0 && UNITS.indexOf(next) < 10) {
      flush();
      out.push(String(UNITS.indexOf(next)).repeat(REPEATS.get(word)!));
      i++;
    } else if (DIGITS.test(word) && (continues() || SCALES.has(next) || next === 'hundred')) {
      if (!continues()) flush();
      current += Number(word);
      last = 'unit';
    } else if (unit >= 0) {
      if (unit < 10 && last === 'tens' && current % 10 === 0) current += unit;
      else if (continues()) current += unit;
      else { flush(); current = unit; }
      last = 'unit';
    } else if (tens > 0) {
      if (continues()) current += tens * 10;
      else { flush(); current = tens * 10; }
      last = 'tens';
    } else if (word === 'hundred') {
      current = (last === 'none' || last === 'scale' ? Math.max(current, 1) : current) * 100;
      last = 'hundred';
    } else if (SCALES.has(word) && last !== 'none') {
      total += Math.max(current, 1) * SCALES.get(word)!;
      current = 0;
      last = 'scale';
    } else if (word === 'and' && continues() && UNITS.concat(TENS).includes(next)) {
      continue;
    } else {
      flush();
      out.push(word);
    }
  }
  flush();
  // ponytail: joins every digit run on both sides ("965 937" = "965937"), so "2 3" also equals "23"; rare in dictation.
  return out.reduce<string[]>((joined, word) => {
    if (DIGITS.test(word) && DIGITS.test(joined.at(-1) ?? '')) joined[joined.length - 1] += word;
    else joined.push(word);
    return joined;
  }, []);
}

/** WER tokens: case, punctuation, fillers, number formatting and British/American spelling don't count. */
export function normalize(text: string): string[] {
  const words = text
    .toLowerCase()
    .normalize('NFC')
    .replace(/(\d),(?=\d)/g, '$1')
    .replace(/(\d)\.(?=\d)/g, '$1 point ') // "1.5" and "one point five" agree, and never equal "15"
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .split(/\s+/)
    .filter((word) => word && !FILLERS.has(word))
    .map((word) => SPELLINGS.get(word) ?? word);
  return digitize(words);
}

/** Word-level Levenshtein alignment counts. */
export function align(ref: string[], hyp: string[]): { errors: number; deletions: number; insertions: number } {
  // cost[i][j] with backtrace via parallel arrays: 0 match/sub, 1 deletion, 2 insertion
  const rows = ref.length + 1;
  const cols = hyp.length + 1;
  const cost = new Uint32Array(rows * cols);
  const move = new Uint8Array(rows * cols);
  for (let i = 1; i < rows; i++) { cost[i * cols] = i; move[i * cols] = 1; }
  for (let j = 1; j < cols; j++) { cost[j] = j; move[j] = 2; }
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const sub = cost[(i - 1) * cols + j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      const del = cost[(i - 1) * cols + j] + 1;
      const ins = cost[i * cols + j - 1] + 1;
      const best = Math.min(sub, del, ins);
      cost[i * cols + j] = best;
      move[i * cols + j] = best === sub ? 0 : best === del ? 1 : 2;
    }
  }
  let deletions = 0;
  let insertions = 0;
  for (let i = ref.length, j = hyp.length; i > 0 || j > 0;) {
    const m = move[i * cols + j];
    if (m === 0) { i--; j--; } else if (m === 1) { deletions++; i--; } else { insertions++; j--; }
  }
  return { errors: cost[rows * cols - 1], deletions, insertions };
}

export function scoreClip(id: string, reference: string, hypothesis: string, latenciesMs: number[] = []): ClipScore {
  const ref = normalize(reference);
  const hyp = normalize(hypothesis);
  const rawRef = reference.trim().split(/\s+/).filter(Boolean);
  const rawHyp = hypothesis.trim().split(/\s+/).filter(Boolean);
  return {
    id,
    words: ref.length,
    ...align(ref, hyp),
    firstThreeWrong: ref.slice(0, 3).join(' ') !== hyp.slice(0, 3).join(' '),
    rawWords: rawRef.length,
    rawErrors: align(rawRef, rawHyp).errors,
    // ponytail: non-ASCII letters = wrong language; misfires on accented names and misses ASCII output like "hola gracias".
    // Swap for a language-ID model if that matters.
    wrongLanguage: /\P{ASCII}/u.test(hypothesis.replace(/[^\p{L}]/gu, '')),
    latenciesMs,
  };
}

const sum = (clips: ClipScore[], key: 'words' | 'errors' | 'deletions' | 'insertions' | 'rawWords' | 'rawErrors') =>
  clips.reduce((total, clip) => total + clip[key], 0);
const rate = (clips: ClipScore[], hit: (clip: ClipScore) => boolean) => clips.filter(hit).length / clips.length;

function quantile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = values.toSorted((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
}

// Quantiles over individual decodes, so a few very slow decodes can't hide behind a per-clip median.
const decodes = (clips: ClipScore[]) => clips.flatMap((clip) => clip.latenciesMs);

type Stat = (clips: ClipScore[]) => number;

/** Can earn a pass and must not regress. Lower is better; NaN means the run didn't measure it. */
export const HEADLINE: Record<string, Stat> = {
  wer: (clips) => sum(clips, 'errors') / Math.max(1, sum(clips, 'words')),
  firstThreeErrorRate: (clips) => rate(clips, (clip) => clip.firstThreeWrong),
  latencyP50Ms: (clips) => quantile(decodes(clips), 0.5),
  latencyP95Ms: (clips) => quantile(decodes(clips), 0.95),
};

/** Can't earn a pass, but a significant regression still fails it. */
export const PROTECTED: Record<string, Stat> = {
  deletionRate: (clips) => sum(clips, 'deletions') / Math.max(1, sum(clips, 'words')),
  insertionRate: (clips) => sum(clips, 'insertions') / Math.max(1, sum(clips, 'words')),
  punctuationCaseWer: (clips) => sum(clips, 'rawErrors') / Math.max(1, sum(clips, 'rawWords')),
  wrongLanguageRate: (clips) => rate(clips, (clip) => clip.wrongLanguage),
};

export function totals(result: Result) {
  const { clips } = result;
  return {
    clips: clips.length,
    ...Object.fromEntries(Object.entries({ ...HEADLINE, ...PROTECTED }).map(([name, stat]) => [name, stat(clips)])),
    ...result.run,
  };
}

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Paired bootstrap of stat(current) - stat(baseline): clips are resampled together, timings included. */
function bootstrapDeltas(current: ClipScore[], baseline: ClipScore[], stat: Stat, resamples = 2000): number[] {
  const random = mulberry32(1);
  const deltas: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const picks = current.map(() => Math.floor(random() * current.length));
    deltas.push(stat(picks.map((i) => current[i])) - stat(picks.map((i) => baseline[i])));
  }
  return deltas;
}

/**
 * The acceptance rule from the verification loop plan. Held-out reproduction is a separate run.
 * A pass needs every headline metric measured, one of them improved with its Bonferroni-corrected
 * interval below zero (so picking "any winner" of four stays a 95% decision), no headline or
 * protected metric worse at 95%, and all guardrails held.
 */
export function accept(current: Result, baseline: Result) {
  for (const result of [current, baseline]) {
    if (new Set(result.clips.map((clip) => clip.id)).size !== result.clips.length) {
      throw new Error(`Duplicate clip ids in the ${result === current ? 'current run' : 'baseline'}.`);
    }
  }
  const byId = new Map(baseline.clips.map((clip) => [clip.id, clip]));
  if (current.clips.length !== baseline.clips.length || current.clips.some((clip) => !byId.has(clip.id))) {
    throw new Error('Current run and baseline cover different clips; regenerate the baseline for this set.');
  }
  if (current.fingerprint !== baseline.fingerprint) {
    throw new Error('The scorer or references changed since the baseline; regenerate it.');
  }
  const paired = current.clips.map((clip) => byId.get(clip.id)!);
  const measured = (stat: Stat) => !Number.isNaN(stat(current.clips)) && !Number.isNaN(stat(paired));
  const improveTail = 0.05 / Object.keys(HEADLINE).length / 2;

  const compare = (stats: Record<string, Stat>, canImprove: boolean) =>
    Object.fromEntries(Object.entries(stats).filter(([, stat]) => measured(stat)).map(([name, stat]) => {
      const deltas = bootstrapDeltas(current.clips, paired, stat);
      return [name, {
        delta: stat(current.clips) - stat(paired),
        low: quantile(deltas, 0.025),
        high: quantile(deltas, 0.975),
        improved: canImprove && quantile(deltas, 1 - improveTail) < 0,
      }];
    }));
  const headline = compare(HEADLINE, true);
  const protectedMetrics = compare(PROTECTED, false);
  // Accuracy-only runs are for exploring; they can't certify a change because latency went unmeasured.
  const complete = Object.keys(headline).length === Object.keys(HEADLINE).length;
  const improved = Object.values(headline).some((ci) => ci.improved);
  const regressed = Object.values({ ...headline, ...protectedMetrics }).some((ci) => ci.low > 0);
  const guardrails = {
    ram: current.run.peakRssMb <= baseline.run.peakRssMb * 1.1,
    cpu: current.run.cpuMsPerClip <= baseline.run.cpuMsPerClip * 1.15,
    coldStart: current.run.coldStartMs <= baseline.run.coldStartMs + 1000,
  };
  return {
    pass: complete && improved && !regressed && Object.values(guardrails).every(Boolean),
    complete,
    improved,
    regressed,
    headline,
    protected: protectedMetrics,
    guardrails,
  };
}
