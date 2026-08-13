import { describe, expect, it } from 'bun:test';
import {
  createMarkerCollector,
  createFileMarkerSink,
  parseMarkerConfig,
  sanitizeMarkerFields,
  type PerformanceMarker,
} from '../performance/marker-collector';
import { buildElectronProcessInventory } from '../performance/process-inventory';
import { createRuntimeReadinessBarrier } from '../performance/runtime-readiness';

describe('buildElectronProcessInventory', () => {
  it('maps Electron roles and renderer PIDs to semantic surfaces', () => {
    expect(buildElectronProcessInventory(
      [
        { pid: 10, type: 'Browser', name: 'Shuddhalekhan' },
        { pid: 20, type: 'Tab', name: 'Renderer' },
        { pid: 30, type: 'GPU', name: 'GPU Process' },
      ],
      [{ webContentsId: 7, pid: 20, url: 'file:///app/index.html#/recording?mode=dictation' }],
    )).toEqual({
      processes: [
        { pid: 10, role: 'electron-main' },
        { pid: 20, role: 'electron-renderer' },
        { pid: 30, role: 'electron-gpu' },
      ],
      windows: [{ webContentsId: 7, pid: 20, surface: 'recording' }],
    });
  });
});

describe('createRuntimeReadinessBarrier', () => {
  it('becomes operational once after both main setup and the shell paint proxy are ready', () => {
    let operationalCount = 0;
    const barrier = createRuntimeReadinessBarrier(() => { operationalCount += 1; });

    barrier.markMainReady();
    expect(operationalCount).toBe(0);
    barrier.markShellPaintReady();
    barrier.markShellPaintReady();
    barrier.markMainReady();

    expect(operationalCount).toBe(1);
  });
});

describe('parseMarkerConfig', () => {
  it('returns disabled when the opt-in env flag is unset', () => {
    expect(parseMarkerConfig({})).toEqual({ enabled: false });
  });

  it('enables markers when SHUDDHALEKHAN_PERF_MARKERS is set', () => {
    expect(parseMarkerConfig({
      SHUDDHALEKHAN_PERF_MARKERS: '1',
      SHUDDHALEKHAN_PERF_RUN_ID: 'run-a',
      SHUDDHALEKHAN_PERF_SCENARIO_ID: 'dictation-idle',
      SHUDDHALEKHAN_PERF_EVENTS_PATH: '/tmp/events.jsonl',
    })).toEqual({
      enabled: true,
      runId: 'run-a',
      scenarioId: 'dictation-idle',
      eventsPath: '/tmp/events.jsonl',
    });
  });
});

describe('sanitizeMarkerFields', () => {
  it('strips transcript, credential, and tool-argument fields', () => {
    expect(sanitizeMarkerFields({
      recordingSessionId: 'session-1',
      transcript: 'secret speech',
      delta: 'partial text',
      arguments: { path: '/etc/passwd' },
      apiKey: 'sk-test',
      response: 'model output',
    })).toEqual({
      recordingSessionId: 'session-1',
    });
  });
});

describe('createMarkerCollector', () => {
  it('keeps the marker envelope authoritative and removes nested sensitive content', () => {
    const lines: string[] = [];
    const collector = createMarkerCollector(
      {
        enabled: true,
        runId: 'run-owned-by-harness',
        scenarioId: 'scenario-owned-by-harness',
        eventsPath: '/tmp/events.jsonl',
      },
      {
        pid: 42,
        now: () => 1000,
        utc: () => '2026-08-12T16:30:00.000Z',
        writeLine: (line) => lines.push(line),
      },
    );

    collector.emit('recording.begin.accepted', {
      event: 'forged.event',
      runId: 'forged-run',
      sequence: 999,
      metadata: {
        transcript: 'private speech',
        safeCount: 3,
      },
    });

    expect(JSON.parse(lines[0])).toEqual({
      schemaVersion: 1,
      runId: 'run-owned-by-harness',
      scenarioId: 'scenario-owned-by-harness',
      sequence: 1,
      event: 'recording.begin.accepted',
      mainMonotonicMs: 1000,
      utc: '2026-08-12T16:30:00.000Z',
      pid: 42,
      processRole: 'electron-main',
      metadata: { safeCount: 3 },
    });
  });

  it('is a no-op when measurement is disabled', () => {
    const lines: string[] = [];
    const collector = createMarkerCollector(
      { enabled: false },
      { pid: 42, now: () => 100, writeLine: (line) => lines.push(line) },
    );

    collector.emit('runtime.operational');
    expect(lines).toEqual([]);
  });

  it('writes JSONL markers with monotonic sequence when enabled', () => {
    const lines: string[] = [];
    let clock = 1000;
    const collector = createMarkerCollector(
      {
        enabled: true,
        runId: 'run-1',
        scenarioId: 'startup-idle',
        eventsPath: '/tmp/events.jsonl',
      },
      {
        pid: 42,
        now: () => clock,
        writeLine: (line) => lines.push(line),
        utc: () => '2026-08-12T16:30:00.000Z',
      },
    );

    collector.emit('app.electron-ready');
    clock = 1250;
    collector.emit('runtime.operational', { surface: 'tray' });

    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as PerformanceMarker;
    const second = JSON.parse(lines[1]) as PerformanceMarker;

    expect(first).toMatchObject({
      schemaVersion: 1,
      runId: 'run-1',
      scenarioId: 'startup-idle',
      sequence: 1,
      event: 'app.electron-ready',
      mainMonotonicMs: 1000,
      utc: '2026-08-12T16:30:00.000Z',
      pid: 42,
      processRole: 'electron-main',
    });
    expect(second.sequence).toBe(2);
    expect(second.event).toBe('runtime.operational');
    expect(second.surface).toBe('tray');
    expect(second.mainMonotonicMs).toBe(1250);
  });

  it('correlates recording and agent identifiers without sensitive payloads', () => {
    const lines: string[] = [];
    const collector = createMarkerCollector(
      {
        enabled: true,
        runId: 'run-2',
        scenarioId: 'recording',
        eventsPath: '/tmp/events.jsonl',
      },
      { pid: 7, now: () => 50, writeLine: (line) => lines.push(line) },
    );

    collector.emit('recording.begin.accepted', {
      recordingSessionId: 'rec-1',
      transcript: 'must not appear',
    });
    collector.emit('agent.run.requested', {
      agentRunId: 'agent-1',
      arguments: { secret: true },
    });

    const accepted = JSON.parse(lines[0]);
    const requested = JSON.parse(lines[1]);
    expect(accepted.recordingSessionId).toBe('rec-1');
    expect(accepted.transcript).toBeUndefined();
    expect(requested.agentRunId).toBe('agent-1');
    expect(requested.arguments).toBeUndefined();
  });
});

describe('createFileMarkerSink', () => {
  it('opens once, preserves line order, and treats benchmark I/O failures as non-fatal', () => {
    const writes: string[] = [];
    let openCount = 0;
    const sink = createFileMarkerSink('events.jsonl', {
      openSync: () => { openCount += 1; return 17; },
      writeSync: (_fd, line) => {
        writes.push(line);
        if (writes.length === 2) throw new Error('disk full');
        return line.length;
      },
    });

    sink.writeLine('{"sequence":1}\n');
    expect(() => sink.writeLine('{"sequence":2}\n')).not.toThrow();
    expect(() => sink.writeLine('{"sequence":3}\n')).not.toThrow();

    expect(openCount).toBe(1);
    expect(writes).toEqual(['{"sequence":1}\n', '{"sequence":2}\n']);
  });
});
