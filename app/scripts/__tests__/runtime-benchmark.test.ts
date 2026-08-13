import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildBenchmarkSummary } from '../runtime-benchmark';

describe('buildBenchmarkSummary', () => {
  it('correlates marker and process sample artifacts into summary files', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'shuddhalekhan-benchmark-'));
    writeFileSync(join(outputDir, 'events.jsonl'), [
      '{"schemaVersion":1,"runId":"r1","scenarioId":"dictation-idle","sequence":1,"event":"app.electron-ready","mainMonotonicMs":0,"utc":"t1","pid":1,"processRole":"electron-main"}',
      '{"schemaVersion":1,"runId":"r1","scenarioId":"dictation-idle","sequence":2,"event":"runtime.operational","mainMonotonicMs":120,"utc":"t2","pid":1,"processRole":"electron-main"}',
      '{"schemaVersion":1,"runId":"r1","scenarioId":"dictation-idle","sequence":3,"event":"hotkey.detected","mainMonotonicMs":200,"utc":"t3","pid":1,"processRole":"electron-main"}',
      '{"schemaVersion":1,"runId":"r1","scenarioId":"dictation-idle","sequence":4,"event":"audio.capture.started","mainMonotonicMs":260,"utc":"t4","pid":1,"processRole":"electron-main"}',
    ].join('\n'));
    writeFileSync(join(outputDir, 'external-events.jsonl'), [
      '{"schemaVersion":1,"runId":"r1","scenarioId":"dictation-idle","sequence":1,"event":"process.launch.requested","qpcTicks":1000,"qpcFrequency":10000,"utc":"t0"}',
      '{"schemaVersion":1,"runId":"r1","scenarioId":"dictation-idle","sequence":2,"event":"runtime.operational.received","qpcTicks":3500,"qpcFrequency":10000,"utc":"t1","pid":1}',
    ].join('\n'));
    writeFileSync(join(outputDir, 'process-samples.csv'), [
      'sampleIndex,qpcTicks,qpcFrequency,utc,pid,creationTime,role,privateBytes,workingSet,handleCount,threadCount,cpuPercent',
      '0,1000,10000000,2026-08-12T16:30:01.000Z,10,2026-08-12T16:29:00.000Z,electron-main,1048576,2097152,100,8,1.0',
    ].join('\n'));
    writeFileSync(join(outputDir, 'docker-samples.csv'), [
      'sampleIndex,qpcTicks,qpcFrequency,utc,containerId,cpuPercent,memoryUsage,memoryLimit,networkInput,networkOutput,blockInput,blockOutput,pids',
      '0,1000,10000,t0,container-1,1.25,64MiB,1GiB,1kB,2kB,3kB,4kB,7',
    ].join('\n'));
    writeFileSync(join(outputDir, 'gpu-samples.csv'), [
      'sampleIndex,qpcTicks,qpcFrequency,utc,gpuUuid,utilizationPercent,memoryUsedMiB,memoryTotalMiB,powerWatts,temperatureCelsius',
      '0,1000,10000,t0,GPU-1,42,1024,8192,75.5,55',
    ].join('\n'));

    const summary = buildBenchmarkSummary(outputDir);
    expect(summary.markerSummary['main-runtime-initialization']?.p50).toBe(120);
    expect(summary.externalMarkerSummary['cold-startup']?.p50).toBe(250);
    expect(summary.markerSummary['recording-activation']).toBeUndefined();
    expect(summary.privateBytesByRole['electron-main']).toBe(1048576);
    expect(summary.processSummary).toEqual({
      privateBytesByRole: {
        'electron-main': { median: 1048576, p95: 1048576, max: 1048576 },
      },
      workingSetByRole: {
        'electron-main': { median: 2097152, p95: 2097152, max: 2097152 },
      },
      cpuPercentByRole: {},
      inventories: [{
        sampleIndex: 0,
        processes: [{
          pid: 10,
          creationTime: '2026-08-12T16:29:00.000Z',
          role: 'electron-main',
        }],
      }],
    });
    expect(summary.externalResourceSummary).toEqual({
      docker: {
        'container-1': {
          cpuPercent: { median: 1.25, p95: 1.25, max: 1.25 },
          memoryUsageBytes: { median: 67108864, p95: 67108864, max: 67108864 },
          pids: { median: 7, p95: 7, max: 7 },
        },
      },
      gpu: {
        'GPU-1': {
          utilizationPercent: { median: 42, p95: 42, max: 42 },
          memoryUsedMiB: { median: 1024, p95: 1024, max: 1024 },
          powerWatts: { median: 75.5, p95: 75.5, max: 75.5 },
        },
      },
    });
  });
});
