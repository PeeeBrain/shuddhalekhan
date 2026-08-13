import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAbbaSchedule, executeAbbaSchedule } from '../performance/scenario-runner';
import { parseProcessSampleCsv } from '../performance/process-sample';

describe('createAbbaSchedule', () => {
  it('interleaves equal baseline and candidate repetitions in ABBA order', () => {
    expect(createAbbaSchedule({
      baselineLabel: 'main',
      candidateLabel: 'candidate',
      repetitionsPerBuild: 4,
    })).toEqual([
      { buildLabel: 'main', repetition: 1 },
      { buildLabel: 'candidate', repetition: 1 },
      { buildLabel: 'candidate', repetition: 2 },
      { buildLabel: 'main', repetition: 2 },
      { buildLabel: 'main', repetition: 3 },
      { buildLabel: 'candidate', repetition: 3 },
      { buildLabel: 'candidate', repetition: 4 },
      { buildLabel: 'main', repetition: 4 },
    ]);
  });

  it('executes every scheduled run in an isolated artifact directory', async () => {
    const calls: Array<{ buildLabel: string; repetition: number; outputDir: string }> = [];
    await executeAbbaSchedule({
      outputRoot: 'benchmark-output/startup',
      schedule: createAbbaSchedule({
        baselineLabel: 'main',
        candidateLabel: 'candidate',
        repetitionsPerBuild: 2,
      }),
      runOne: async (run) => { calls.push(run); },
    });

    expect(calls).toEqual([
      { buildLabel: 'main', repetition: 1, outputDir: join('benchmark-output/startup', '001-main-001') },
      { buildLabel: 'candidate', repetition: 1, outputDir: join('benchmark-output/startup', '002-candidate-001') },
      { buildLabel: 'candidate', repetition: 2, outputDir: join('benchmark-output/startup', '003-candidate-002') },
      { buildLabel: 'main', repetition: 2, outputDir: join('benchmark-output/startup', '004-main-002') },
    ]);
  });
});

describe('runtime-scenario-runner.ps1', () => {
  it('captures QPC startup endpoints and samples the explicitly launched process', async () => {
    if (process.platform !== 'win32') return;

    const outputDir = mkdtempSync(join(tmpdir(), 'shuddhalekhan-scenario-'));
    const fakeAppPath = join(outputDir, 'fake-packaged-app.ps1');
    writeFileSync(fakeAppPath, `
$eventsPath = $env:SHUDDHALEKHAN_PERF_EVENTS_PATH
$runId = $env:SHUDDHALEKHAN_PERF_RUN_ID
$scenarioId = $env:SHUDDHALEKHAN_PERF_SCENARIO_ID
$pidValue = $PID
@(
  @{ schemaVersion = 1; runId = $runId; scenarioId = $scenarioId; sequence = 1; event = 'app.electron-ready'; mainMonotonicMs = 10; utc = [DateTime]::UtcNow.ToString('o'); pid = $pidValue; processRole = 'electron-main' },
  @{ schemaVersion = 1; runId = $runId; scenarioId = $scenarioId; sequence = 2; event = 'runtime.operational'; mainMonotonicMs = 20; utc = [DateTime]::UtcNow.ToString('o'); pid = $pidValue; processRole = 'electron-main' }
) | ForEach-Object { Add-Content -LiteralPath $eventsPath -Value ($_ | ConvertTo-Json -Compress) }
Start-Sleep -Seconds 10
`);

    const result = Bun.spawnSync([
      'pwsh',
      '-NoProfile',
      '-File',
      join(import.meta.dir, '..', 'runtime-scenario-runner.ps1'),
      '-OutputDir',
      outputDir,
      '-ExecutablePath',
      'pwsh',
      '-ExecutableArgumentsJson',
      JSON.stringify(['-NoProfile', '-File', fakeAppPath]),
      '-ScenarioId',
      'dictation-idle',
      '-RunId',
      'idle-001',
      '-SettleSeconds',
      '0',
      '-SampleCount',
      '1',
      '-SampleIntervalMs',
      '10',
      '-StartupTimeoutSeconds',
      '5',
    ]);

    expect(result.exitCode).toBe(0);
    const externalEvents = (await Bun.file(join(outputDir, 'external-events.jsonl')).text())
      .trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(externalEvents.map((event) => event.event)).toEqual([
      'process.launch.requested',
      'runtime.operational.received',
    ]);
    expect(externalEvents.every((event) => event.qpcTicks > 0 && event.qpcFrequency > 0)).toBe(true);

    const samples = parseProcessSampleCsv(await Bun.file(join(outputDir, 'process-samples.csv')).text());
    expect(samples).toHaveLength(1);
    expect(samples[0]?.role).toBe('electron-main');
    const captureMetadata = await Bun.file(join(outputDir, 'capture-metadata.json')).json();
    expect(captureMetadata.comparability).toBe('diagnostic-unverified');
  }, 15_000);
});
