import { describe, expect, it } from 'bun:test';
import {
  parseProcessSampleCsv,
  summarizeProcessSamples,
  type ProcessSample,
} from '../performance/process-sample';

describe('parseProcessSampleCsv', () => {
  it('parses QPC-backed process samples with stable identity fields', () => {
    const csv = [
      'sampleIndex,qpcTicks,qpcFrequency,utc,pid,creationTime,role,privateBytes,workingSet,handleCount,threadCount,cpuPercent',
      '0,1000000,10000000,2026-08-12T16:30:01.000Z,1234,2026-08-12T16:29:00.000Z,electron-main,1048576,2097152,120,8,1.2',
      '1,1010000,10000000,2026-08-12T16:30:02.000Z,1234,2026-08-12T16:29:00.000Z,electron-main,1052672,2101248,121,8,1.0',
    ].join('\n');

    const samples = parseProcessSampleCsv(csv);
    expect(samples).toHaveLength(2);
    expect(samples[0]).toEqual({
      sampleIndex: 0,
      qpcTicks: 1000000,
      qpcFrequency: 10000000,
      utc: '2026-08-12T16:30:01.000Z',
      pid: 1234,
      creationTime: '2026-08-12T16:29:00.000Z',
      role: 'electron-main',
      privateBytes: 1048576,
      workingSet: 2097152,
      handleCount: 120,
      threadCount: 8,
      cpuPercent: 1.2,
    } satisfies ProcessSample);
  });
});

describe('summarizeProcessSamples', () => {
  it('reports role distributions and exact process inventories per sample', () => {
    const base = {
      qpcFrequency: 10_000_000,
      utc: '2026-08-12T16:30:01.000Z',
      creationTime: '2026-08-12T16:29:00.000Z',
      workingSet: 50,
      handleCount: 10,
      threadCount: 2,
      cpuPercent: 1,
    };
    const samples: ProcessSample[] = [
      { ...base, sampleIndex: 0, qpcTicks: 100, pid: 10, role: 'electron-main', privateBytes: 100 },
      { ...base, sampleIndex: 1, qpcTicks: 200, pid: 10, role: 'electron-main', privateBytes: 200 },
      { ...base, sampleIndex: 2, qpcTicks: 300, pid: 10, role: 'electron-main', privateBytes: 300 },
      { ...base, sampleIndex: 2, qpcTicks: 300, pid: 20, role: 'agent-sidecar', privateBytes: 400 },
    ];

    expect(summarizeProcessSamples(samples)).toEqual({
      privateBytesByRole: {
        'electron-main': { median: 200, p95: 290, max: 300 },
        'agent-sidecar': { median: 400, p95: 400, max: 400 },
      },
      workingSetByRole: {
        'electron-main': { median: 50, p95: 50, max: 50 },
        'agent-sidecar': { median: 50, p95: 50, max: 50 },
      },
      cpuPercentByRole: {
        'electron-main': { median: 1, p95: 1, max: 1 },
      },
      inventories: [
        { sampleIndex: 0, processes: [{ pid: 10, creationTime: base.creationTime, role: 'electron-main' }] },
        { sampleIndex: 1, processes: [{ pid: 10, creationTime: base.creationTime, role: 'electron-main' }] },
        {
          sampleIndex: 2,
          processes: [
            { pid: 10, creationTime: base.creationTime, role: 'electron-main' },
            { pid: 20, creationTime: base.creationTime, role: 'agent-sidecar' },
          ],
        },
      ],
    });
  });
});
