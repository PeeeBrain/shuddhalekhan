import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';

type QualityCase = {
  name: string;
  file: string;
  expected: string;
  language?: string;
  maxWer?: number;
  maxCer?: number;
};

type Manifest = {
  endpoint?: string;
  language?: string;
  maxWer?: number;
  maxCer?: number;
  cases: QualityCase[];
};

type CliOptions = {
  manifest: string;
  endpoint?: string;
};

type CaseResult = {
  name: string;
  transcript: string;
  expected: string;
  wer: number;
  cer: number;
  passed: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    manifest: 'scripts/transcription-quality-cases.json',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--manifest' && next) {
      options.manifest = next;
      index += 1;
    } else if (arg === '--endpoint' && next) {
      options.endpoint = next;
      index += 1;
    }
  }

  return options;
}

export function normalizeTranscript(text: string): string {
  return text
    .toLocaleLowerCase('mr-IN')
    .normalize('NFC')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshteinDistance<T>(actual: T[], expected: T[]): number {
  const previous = Array.from({ length: expected.length + 1 }, (_, index) => index);
  const current = Array.from({ length: expected.length + 1 }, () => 0);

  for (let actualIndex = 1; actualIndex <= actual.length; actualIndex += 1) {
    current[0] = actualIndex;

    for (let expectedIndex = 1; expectedIndex <= expected.length; expectedIndex += 1) {
      const substitutionCost = Object.is(actual[actualIndex - 1], expected[expectedIndex - 1]) ? 0 : 1;
      current[expectedIndex] = Math.min(
        previous[expectedIndex] + 1,
        current[expectedIndex - 1] + 1,
        previous[expectedIndex - 1] + substitutionCost
      );
    }

    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index];
    }
  }

  return previous[expected.length];
}

export function wordErrorRate(actual: string, expected: string): number {
  const actualWords = normalizeTranscript(actual).split(' ').filter(Boolean);
  const expectedWords = normalizeTranscript(expected).split(' ').filter(Boolean);
  if (expectedWords.length === 0) return actualWords.length === 0 ? 0 : 1;
  return levenshteinDistance(actualWords, expectedWords) / expectedWords.length;
}

export function characterErrorRate(actual: string, expected: string): number {
  const actualChars = Array.from(normalizeTranscript(actual).replace(/\s+/g, ''));
  const expectedChars = Array.from(normalizeTranscript(expected).replace(/\s+/g, ''));
  if (expectedChars.length === 0) return actualChars.length === 0 ? 0 : 1;
  return levenshteinDistance(actualChars, expectedChars) / expectedChars.length;
}

function readManifest(path: string): Manifest {
  if (!existsSync(path)) {
    throw new Error(`Manifest does not exist: ${path}`);
  }

  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error('Manifest must include at least one transcription quality case');
  }

  for (const testCase of manifest.cases) {
    if (!existsSync(testCase.file)) {
      throw new Error(`Audio file does not exist for ${testCase.name}: ${testCase.file}`);
    }
  }

  return manifest;
}

function extractTranscript(responseBody: string): string {
  try {
    const parsed = JSON.parse(responseBody) as { text?: unknown; transcript?: unknown };
    if (typeof parsed.text === 'string') return parsed.text;
    if (typeof parsed.transcript === 'string') return parsed.transcript;
  } catch {
    // Some whisper-compatible endpoints return plain text.
  }

  return responseBody;
}

async function transcribe(testCase: QualityCase, endpoint: string, defaultLanguage: string): Promise<string> {
  const form = new FormData();
  const audio = readFileSync(testCase.file);
  form.append('file', new Blob([audio], { type: 'audio/wav' }), basename(testCase.file));
  form.append('temperature', '0.0');
  form.append('response_format', 'json');
  form.append('translate', 'false');

  const language = testCase.language ?? defaultLanguage;
  if (language !== 'auto') {
    form.append('language', language);
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    body: form as unknown as BodyInit,
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${testCase.name}: ${response.status} ${response.statusText}: ${body}`);
  }

  return extractTranscript(body);
}

async function runQualityCheck(options: CliOptions): Promise<CaseResult[]> {
  const manifest = readManifest(options.manifest);
  const endpoint = options.endpoint ?? manifest.endpoint ?? 'http://localhost:8080/inference';
  const defaultLanguage = manifest.language ?? 'mr';
  const defaultMaxWer = manifest.maxWer ?? 0.15;
  const defaultMaxCer = manifest.maxCer ?? 0.08;

  const results: CaseResult[] = [];
  for (const testCase of manifest.cases) {
    const transcript = await transcribe(testCase, endpoint, defaultLanguage);
    const wer = wordErrorRate(transcript, testCase.expected);
    const cer = characterErrorRate(transcript, testCase.expected);
    const maxWer = testCase.maxWer ?? defaultMaxWer;
    const maxCer = testCase.maxCer ?? defaultMaxCer;
    const passed = wer <= maxWer && cer <= maxCer;
    results.push({ name: testCase.name, transcript, expected: testCase.expected, wer, cer, passed });
  }

  return results;
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const results = await runQualityCheck(options);
  let failed = false;

  for (const result of results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    console.log(`\n${status} ${result.name}`);
    console.log(`WER: ${(result.wer * 100).toFixed(2)}%`);
    console.log(`CER: ${(result.cer * 100).toFixed(2)}%`);
    console.log(`Expected: ${result.expected}`);
    console.log(`Actual:   ${result.transcript}`);
    failed ||= !result.passed;
  }

  if (failed) {
    process.exitCode = 1;
  }
}
