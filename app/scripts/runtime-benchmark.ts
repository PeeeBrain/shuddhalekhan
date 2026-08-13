import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { buildMarkerSummary, parseMarkerStream } from './performance/summarize-markers';
import {
  groupPrivateBytesByRole,
  parseProcessSampleCsv,
  summarizeProcessSamples,
} from './performance/process-sample';
import {
  buildExternalMarkerSummary,
  parseExternalEventStream,
} from './performance/summarize-external-events';
import { createAbbaSchedule, executeAbbaSchedule } from './performance/scenario-runner';
import { summarizeExternalResources } from './performance/external-resource-sample';
import {
  aggregateLatencyObservations,
  type LatencyObservation,
} from './performance/aggregate-summary';

export type BenchmarkArtifactPaths = {
  metadata: string;
  events: string;
  externalEvents: string;
  processSamples: string;
  dockerSamples: string;
  gpuSamples: string;
  summaryJson: string;
  summaryMarkdown: string;
};

export function resolveBenchmarkArtifactPaths(outputDir: string): BenchmarkArtifactPaths {
  return {
    metadata: join(outputDir, 'metadata.json'),
    events: join(outputDir, 'events.jsonl'),
    externalEvents: join(outputDir, 'external-events.jsonl'),
    processSamples: join(outputDir, 'process-samples.csv'),
    dockerSamples: join(outputDir, 'docker-samples.csv'),
    gpuSamples: join(outputDir, 'gpu-samples.csv'),
    summaryJson: join(outputDir, 'summary.json'),
    summaryMarkdown: join(outputDir, 'summary.md'),
  };
}

export function buildBenchmarkSummary(outputDir: string): {
  markerSummary: ReturnType<typeof buildMarkerSummary>;
  externalMarkerSummary: ReturnType<typeof buildExternalMarkerSummary>;
  privateBytesByRole: Record<string, number>;
  processSummary: ReturnType<typeof summarizeProcessSamples>;
  externalResourceSummary: ReturnType<typeof summarizeExternalResources>;
} {
  const paths = resolveBenchmarkArtifactPaths(outputDir);
  const markers = parseMarkerStream(readFileSync(paths.events, 'utf8'));
  const externalEvents = existsSync(paths.externalEvents)
    ? parseExternalEventStream(readFileSync(paths.externalEvents, 'utf8'))
    : [];
  const processSamples = parseProcessSampleCsv(readFileSync(paths.processSamples, 'utf8'));
  const dockerSamples = existsSync(paths.dockerSamples) ? readFileSync(paths.dockerSamples, 'utf8') : '';
  const gpuSamples = existsSync(paths.gpuSamples) ? readFileSync(paths.gpuSamples, 'utf8') : '';
  const markerSummary = buildMarkerSummary(markers);
  const externalMarkerSummary = buildExternalMarkerSummary(externalEvents);
  const privateBytesByRole = groupPrivateBytesByRole(processSamples);
  const processSummary = summarizeProcessSamples(processSamples);
  const externalResourceSummary = summarizeExternalResources(dockerSamples, gpuSamples);

  const summary = {
    generatedAt: new Date().toISOString(),
    outputDir: resolve(outputDir),
    markerSummary,
    externalMarkerSummary,
    privateBytesByRole,
    processSummary,
    externalResourceSummary,
    processSampleCount: processSamples.length,
    markerCount: markers.length,
  };

  mkdirSync(dirname(paths.summaryJson), { recursive: true });
  writeFileSync(paths.summaryJson, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  writeFileSync(
    paths.summaryMarkdown,
    [
      '# Runtime benchmark summary',
      '',
      `- Output: \`${summary.outputDir}\``,
      `- Markers: ${summary.markerCount}`,
      `- Process samples: ${summary.processSampleCount}`,
      '',
      '## Marker intervals (ms)',
      '',
      ...Object.entries(markerSummary).map(([name, stats]) =>
        `- ${name}: p50=${stats.p50}, p95=${stats.p95}, max=${stats.max}, failures=${stats.failures}`,
      ),
      ...Object.entries(externalMarkerSummary).map(([name, stats]) =>
        `- ${name}: p50=${stats.p50}, p95=${stats.p95}, max=${stats.max}, failures=${stats.failures}`,
      ),
      '',
      '## Private bytes by role',
      '',
      ...Object.entries(processSummary.privateBytesByRole).map(([role, stats]) =>
        `- ${role}: median=${stats.median}, p95=${stats.p95}, max=${stats.max}`,
      ),
      '',
      '## Process inventories',
      '',
      ...processSummary.inventories.map(({ sampleIndex, processes }) =>
        `- Sample ${sampleIndex}: ${processes.map(({ pid, creationTime, role }) => `${role}=${pid}@${creationTime}`).join(', ')}`,
      ),
      '',
      '## External resources',
      '',
      `- Docker: ${JSON.stringify(externalResourceSummary.docker)}`,
      `- GPU: ${JSON.stringify(externalResourceSummary.gpu)}`,
      '',
    ].join('\n'),
    'utf8',
  );

  return {
    markerSummary,
    externalMarkerSummary,
    privateBytesByRole,
    processSummary,
    externalResourceSummary,
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/runtime-benchmark.ts summarize --output <dir>
  bun run scripts/runtime-benchmark.ts run-abba --baseline-exe <path> --candidate-exe <path> --scenario <id> --repetitions <even> --output <dir>

Environment for packaged app runs:
  SHUDDHALEKHAN_PERF_MARKERS=1
  SHUDDHALEKHAN_PERF_RUN_ID=<run-id>
  SHUDDHALEKHAN_PERF_SCENARIO_ID=<scenario-id>
  SHUDDHALEKHAN_PERF_EVENTS_PATH=<path-to-events.jsonl>

External collector:
  pwsh scripts/performance-collector.ps1 -OutputDir <dir> -ProcessRolesPath <process-roles.json>
`);
}

function readCliOption(args: string[], name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

async function runAbbaCommand(args: string[]): Promise<void> {
  const baselineExe = readCliOption(args, '--baseline-exe');
  const candidateExe = readCliOption(args, '--candidate-exe');
  const scenarioId = readCliOption(args, '--scenario');
  const outputRoot = readCliOption(args, '--output', 'benchmark-output/abba');
  const repetitions = Number(readCliOption(args, '--repetitions', '20'));
  if (!baselineExe || !candidateExe || !scenarioId || !outputRoot) {
    throw new Error('run-abba requires --baseline-exe, --candidate-exe, --scenario, and --output');
  }

  const baselineLabel = readCliOption(args, '--baseline-label', 'baseline')!;
  const candidateLabel = readCliOption(args, '--candidate-label', 'candidate')!;
  const settleSeconds = readCliOption(args, '--settle-seconds', '60')!;
  const sampleCount = readCliOption(args, '--sample-count', '60')!;
  const sampleIntervalMs = readCliOption(args, '--sample-interval-ms', '1000')!;
  const startupTimeoutSeconds = readCliOption(args, '--startup-timeout-seconds', '30')!;
  const comparability = readCliOption(args, '--comparability', 'diagnostic-unverified')!;
  const dockerContainerId = readCliOption(args, '--docker-container-id', '')!;
  const dockerCommandPath = readCliOption(args, '--docker-command', 'docker')!;
  const nvidiaSmiPath = readCliOption(args, '--nvidia-smi', '')!;
  const executableByLabel = new Map([
    [baselineLabel, resolve(baselineExe)],
    [candidateLabel, resolve(candidateExe)],
  ]);
  const schedule = createAbbaSchedule({
    baselineLabel,
    candidateLabel,
    repetitionsPerBuild: repetitions,
  });
  const observations: LatencyObservation[] = [];

  await executeAbbaSchedule({
    outputRoot: resolve(outputRoot),
    schedule,
    async runOne(run) {
      const executable = executableByLabel.get(run.buildLabel);
      if (!executable) throw new Error(`No executable configured for ${run.buildLabel}`);
      const runId = `${scenarioId}-${run.buildLabel}-${String(run.repetition).padStart(3, '0')}`;
      const result = Bun.spawnSync([
        'pwsh',
        '-NoProfile',
        '-File',
        join(import.meta.dir, 'runtime-scenario-runner.ps1'),
        '-OutputDir', run.outputDir,
        '-ExecutablePath', executable,
        '-ScenarioId', scenarioId,
        '-RunId', runId,
        '-BuildLabel', run.buildLabel,
        '-Comparability', comparability,
        '-SettleSeconds', settleSeconds,
        '-SampleCount', sampleCount,
        '-SampleIntervalMs', sampleIntervalMs,
        '-StartupTimeoutSeconds', startupTimeoutSeconds,
        '-DockerContainerId', dockerContainerId,
        '-DockerCommandPath', dockerCommandPath,
        '-NvidiaSmiPath', nvidiaSmiPath,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`Benchmark run ${runId} failed: ${result.stderr.toString().trim()}`);
      }
      const summary = buildBenchmarkSummary(run.outputDir);
      for (const [metric, stats] of Object.entries({
        ...summary.externalMarkerSummary,
        ...summary.markerSummary,
      })) {
        if (stats.count > 0) {
          observations.push({ buildLabel: run.buildLabel, metric, value: stats.p50 });
        }
        for (let index = 0; index < stats.failures; index += 1) {
          observations.push({ buildLabel: run.buildLabel, metric, failed: true });
        }
      }
      for (const [role, stats] of Object.entries(summary.processSummary.privateBytesByRole)) {
        observations.push({
          buildLabel: run.buildLabel,
          metric: `idle-private-bytes:${role}`,
          value: stats.median,
        });
      }
      for (const [role, stats] of Object.entries(summary.processSummary.workingSetByRole)) {
        observations.push({
          buildLabel: run.buildLabel,
          metric: `idle-working-set-non-unique:${role}`,
          value: stats.median,
        });
      }
      for (const [role, stats] of Object.entries(summary.processSummary.cpuPercentByRole)) {
        observations.push({
          buildLabel: run.buildLabel,
          metric: `idle-host-cpu-percent:${role}`,
          value: stats.median,
        });
      }
      console.log(`Completed ${runId}: ${run.outputDir}`);
    },
    betweenRuns: () => Bun.sleep(15_000),
  });

  const aggregate = aggregateLatencyObservations(observations, { baselineLabel, candidateLabel });
  mkdirSync(resolve(outputRoot), { recursive: true });
  writeFileSync(
    join(resolve(outputRoot), 'aggregate-summary.json'),
    `${JSON.stringify(aggregate, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(resolve(outputRoot), 'aggregate-summary.md'),
    [
      '# Runtime benchmark aggregate',
      '',
      `- Baseline: ${baselineLabel}`,
      `- Candidate: ${candidateLabel}`,
      '',
      ...Object.entries(aggregate.deltas).map(([metric, delta]) =>
        `- ${metric}: Δp50=${delta.p50}, Δp95=${delta.p95}, Δmax=${delta.max}`,
      ),
      '',
      'Per-build distributions and MAD noise are available in `aggregate-summary.json`.',
      '',
    ].join('\n'),
    'utf8',
  );
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'run-abba') {
    await runAbbaCommand(args);
  } else if (command !== 'summarize') {
    printUsage();
    process.exit(command ? 1 : 0);
  } else {
    let outputDir = 'benchmark-output';
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--output' && args[index + 1]) {
        outputDir = args[index + 1];
        index += 1;
      }
    }

    const summary = buildBenchmarkSummary(outputDir);
    console.log(JSON.stringify(summary, null, 2));
  }
}
