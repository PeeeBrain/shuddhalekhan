import { describe, expect, it } from 'bun:test';
import {
  buildMarkerMeasurements,
  buildMarkerSummary,
  correlateMarkerIntervals,
  parseMarkerStream,
  summarizeLatency,
} from '../performance/summarize-markers';

describe('parseMarkerStream', () => {
  it('parses JSONL markers in order', () => {
    const markers = parseMarkerStream([
      '{"schemaVersion":1,"runId":"r1","scenarioId":"s1","sequence":1,"event":"hotkey.detected","mainMonotonicMs":10,"utc":"t1","pid":1,"processRole":"electron-main"}',
      '{"schemaVersion":1,"runId":"r1","scenarioId":"s1","sequence":2,"event":"recording.begin.accepted","mainMonotonicMs":20,"utc":"t2","pid":1,"processRole":"electron-main","recordingSessionId":"rec-1"}',
    ].join('\n'));

    expect(markers).toHaveLength(2);
    expect(markers[1]?.recordingSessionId).toBe('rec-1');
  });
});

describe('correlateMarkerIntervals', () => {
  it('computes latency between named start and end events', () => {
    const markers = parseMarkerStream([
      '{"schemaVersion":1,"runId":"r1","scenarioId":"s1","sequence":1,"event":"hotkey.detected","mainMonotonicMs":100,"utc":"t1","pid":1,"processRole":"electron-main"}',
      '{"schemaVersion":1,"runId":"r1","scenarioId":"s1","sequence":2,"event":"audio.capture.started","mainMonotonicMs":180,"utc":"t2","pid":1,"processRole":"electron-main"}',
      '{"schemaVersion":1,"runId":"r1","scenarioId":"s1","sequence":3,"event":"runtime.operational","mainMonotonicMs":900,"utc":"t3","pid":1,"processRole":"electron-main"}',
    ].join('\n'));

    expect(correlateMarkerIntervals(markers, 'hotkey.detected', 'audio.capture.started')).toEqual([80]);
    expect(correlateMarkerIntervals(markers, 'hotkey.detected', 'runtime.operational')).toEqual([800]);
  });

  it('correlates interleaved intervals by their domain identifier', () => {
    const markers = parseMarkerStream([
      '{"schemaVersion":1,"runId":"r1","scenarioId":"recording","sequence":1,"event":"recording.stop.requested","mainMonotonicMs":10,"utc":"t1","pid":1,"processRole":"electron-main","recordingSessionId":"rec-1"}',
      '{"schemaVersion":1,"runId":"r1","scenarioId":"recording","sequence":2,"event":"recording.stop.requested","mainMonotonicMs":20,"utc":"t2","pid":1,"processRole":"electron-main","recordingSessionId":"rec-2"}',
      '{"schemaVersion":1,"runId":"r1","scenarioId":"recording","sequence":3,"event":"recording.session.completed","mainMonotonicMs":50,"utc":"t3","pid":1,"processRole":"electron-main","recordingSessionId":"rec-1"}',
      '{"schemaVersion":1,"runId":"r1","scenarioId":"recording","sequence":4,"event":"recording.session.completed","mainMonotonicMs":80,"utc":"t4","pid":1,"processRole":"electron-main","recordingSessionId":"rec-2"}',
    ].join('\n'));

    expect(correlateMarkerIntervals(
      markers,
      'recording.stop.requested',
      'recording.session.completed',
      { correlationField: 'recordingSessionId' },
    )).toEqual([40, 60]);
  });
});

describe('summarizeLatency', () => {
  it('reports p50, p95, max, and failure count for repetitions', () => {
    const summary = summarizeLatency([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0);
    expect(summary).toEqual({
      count: 10,
      failures: 0,
      p50: 55,
      p95: 95,
      max: 100,
    });
  });

  it('counts missing samples as failures', () => {
    const summary = summarizeLatency([10, 20], 3);
    expect(summary.failures).toBe(1);
    expect(summary.count).toBe(2);
  });
});

describe('buildMarkerSummary', () => {
  it('reports only the metrics required by the captured scenario', () => {
    const markers = parseMarkerStream([
      '{"schemaVersion":1,"runId":"idle-1","scenarioId":"dictation-idle","sequence":1,"event":"app.electron-ready","mainMonotonicMs":100,"utc":"t1","pid":1,"processRole":"electron-main"}',
      '{"schemaVersion":1,"runId":"idle-1","scenarioId":"dictation-idle","sequence":2,"event":"runtime.operational","mainMonotonicMs":180,"utc":"t2","pid":1,"processRole":"electron-main"}',
    ].join('\n'));

    expect(buildMarkerSummary(markers)).toEqual({
      'main-runtime-initialization': {
        count: 1,
        failures: 0,
        p50: 80,
        p95: 80,
        max: 80,
      },
    });
  });

  it('ends Agent first-use latency at the first semantic outcome', () => {
    const markers = parseMarkerStream([
      '{"schemaVersion":1,"runId":"agent-1","scenarioId":"agent-no-mcp","sequence":1,"event":"agent.run.requested","mainMonotonicMs":100,"utc":"t1","pid":1,"processRole":"electron-main","agentRunId":"run-1"}',
      '{"schemaVersion":1,"runId":"agent-1","scenarioId":"agent-no-mcp","sequence":2,"event":"approval.requested","mainMonotonicMs":250,"utc":"t2","pid":1,"processRole":"electron-main","agentRunId":"run-1"}',
    ].join('\n'));

    expect(buildMarkerSummary(markers)).toEqual({
      'agent-first-outcome': {
        count: 1,
        failures: 0,
        p50: 150,
        p95: 150,
        max: 150,
      },
    });
  });

  it('summarizes Settings request to paint-proxy latency', () => {
    const markers = parseMarkerStream([
      '{"schemaVersion":1,"runId":"settings-1","scenarioId":"settings-open","sequence":1,"event":"surface.requested","mainMonotonicMs":100,"utc":"t1","pid":1,"processRole":"electron-main","surface":"settings","transition":"cold-create"}',
      '{"schemaVersion":1,"runId":"settings-1","scenarioId":"settings-open","sequence":2,"event":"surface.paint-proxy","mainMonotonicMs":175,"utc":"t2","pid":1,"processRole":"electron-main","surface":"settings"}',
    ].join('\n'));

    expect(buildMarkerSummary(markers)).toEqual({
      'settings-open': { count: 1, failures: 0, p50: 75, p95: 75, max: 75 },
    });
  });

  it('ends recording activation at the later of capture start and recording paint', () => {
    const markers = parseMarkerStream([
      '{"schemaVersion":1,"runId":"recording-1","scenarioId":"dictation-recording","sequence":1,"event":"hotkey.detected","mainMonotonicMs":100,"utc":"t1","pid":1,"processRole":"electron-main","recordingSessionId":"rec-1","surface":"dictation"}',
      '{"schemaVersion":1,"runId":"recording-1","scenarioId":"dictation-recording","sequence":2,"event":"audio.capture.started","mainMonotonicMs":140,"utc":"t2","pid":1,"processRole":"electron-main","recordingSessionId":"rec-1","surface":"dictation"}',
      '{"schemaVersion":1,"runId":"recording-1","scenarioId":"dictation-recording","sequence":3,"event":"surface.paint-proxy","mainMonotonicMs":170,"utc":"t3","pid":1,"processRole":"electron-main","recordingSessionId":"rec-1","surface":"recording"}',
    ].join('\n'));

    expect(buildMarkerSummary(markers)['recording-activation']).toEqual({
      count: 1,
      failures: 0,
      p50: 70,
      p95: 70,
      max: 70,
    });
  });

  it('summarizes MCP discovery, first-tool, and execution spans', () => {
    const markers = parseMarkerStream([
      '{"schemaVersion":1,"runId":"mcp-1","scenarioId":"mcp-stdio-tool","sequence":1,"event":"agent.run.requested","mainMonotonicMs":100,"utc":"t1","pid":1,"processRole":"electron-main","agentRunId":"agent-1"}',
      '{"schemaVersion":1,"runId":"mcp-1","scenarioId":"mcp-stdio-tool","sequence":2,"event":"mcp.connect.requested","mainMonotonicMs":110,"utc":"t2","pid":1,"processRole":"electron-main","serverId":"echo"}',
      '{"schemaVersion":1,"runId":"mcp-1","scenarioId":"mcp-stdio-tool","sequence":3,"event":"mcp.tools.discovered","mainMonotonicMs":120,"utc":"t3","pid":1,"processRole":"electron-main","serverId":"echo"}',
      '{"schemaVersion":1,"runId":"mcp-1","scenarioId":"mcp-stdio-tool","sequence":4,"event":"mcp.tool.execute.started","mainMonotonicMs":140,"utc":"t4","pid":1,"processRole":"electron-main","agentRunId":"agent-1","serverId":"echo"}',
      '{"schemaVersion":1,"runId":"mcp-1","scenarioId":"mcp-stdio-tool","sequence":5,"event":"mcp.tool.execute.result","mainMonotonicMs":160,"utc":"t5","pid":1,"processRole":"electron-main","agentRunId":"agent-1","serverId":"echo","outcome":"success"}',
      '{"schemaVersion":1,"runId":"mcp-1","scenarioId":"mcp-stdio-tool","sequence":6,"event":"agent.completed","mainMonotonicMs":180,"utc":"t6","pid":1,"processRole":"electron-main","agentRunId":"agent-1"}',
    ].join('\n'));

    expect(buildMarkerSummary(markers)).toMatchObject({
      'mcp-connect-discovery': { p50: 10, failures: 0 },
      'mcp-first-tool': { p50: 40, failures: 0 },
      'mcp-tool-execution': { p50: 20, failures: 0 },
    });
  });

  it('excludes tagged warmups and counts missing measured endpoints as failures', () => {
    const markers = parseMarkerStream([
      '{"schemaVersion":1,"runId":"settings-1","scenarioId":"settings-open","sequence":1,"event":"surface.requested","surface":"settings","benchmarkPhase":"warmup","benchmarkIteration":1,"mainMonotonicMs":10,"utc":"t1","pid":1,"processRole":"electron-main"}',
      '{"schemaVersion":1,"runId":"settings-1","scenarioId":"settings-open","sequence":2,"event":"surface.paint-proxy","surface":"settings","benchmarkPhase":"warmup","benchmarkIteration":1,"mainMonotonicMs":110,"utc":"t2","pid":1,"processRole":"electron-main"}',
      '{"schemaVersion":1,"runId":"settings-1","scenarioId":"settings-open","sequence":3,"event":"surface.requested","surface":"settings","benchmarkPhase":"measured","benchmarkIteration":1,"mainMonotonicMs":200,"utc":"t3","pid":1,"processRole":"electron-main"}',
      '{"schemaVersion":1,"runId":"settings-1","scenarioId":"settings-open","sequence":4,"event":"surface.paint-proxy","surface":"settings","benchmarkPhase":"measured","benchmarkIteration":1,"mainMonotonicMs":225,"utc":"t4","pid":1,"processRole":"electron-main"}',
      '{"schemaVersion":1,"runId":"settings-1","scenarioId":"settings-open","sequence":5,"event":"surface.requested","surface":"settings","benchmarkPhase":"measured","benchmarkIteration":2,"mainMonotonicMs":300,"utc":"t5","pid":1,"processRole":"electron-main"}',
    ].join('\n'));

    expect(buildMarkerSummary(markers)['settings-open']).toEqual({
      count: 1,
      failures: 1,
      p50: 25,
      p95: 25,
      max: 25,
    });
    expect(buildMarkerMeasurements(markers)['settings-open']).toEqual({
      samples: [25],
      expectedCount: 2,
    });
  });
});
