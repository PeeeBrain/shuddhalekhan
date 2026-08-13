import type { PerformanceMarker } from '../../src/main/performance/marker-collector';

export function parseMarkerStream(content: string): PerformanceMarker[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PerformanceMarker);
}

export function correlateMarkerIntervals(
  markers: PerformanceMarker[],
  startEvent: string,
  endEvent: string | string[],
  options: { correlationField?: keyof PerformanceMarker } = {},
): number[] {
  const intervals: number[] = [];
  const endEvents = new Set(Array.isArray(endEvent) ? endEvent : [endEvent]);
  if (options.correlationField) {
    const starts = new Map<string, number>();
    for (const marker of markers) {
      const correlationValue = marker[options.correlationField];
      if (correlationValue === undefined) continue;
      const key = `${marker.runId}:${String(correlationValue)}`;
      if (marker.event === startEvent) {
        starts.set(key, marker.mainMonotonicMs);
        continue;
      }
      if (endEvents.has(marker.event)) {
        const start = starts.get(key);
        if (start === undefined) continue;
        intervals.push(marker.mainMonotonicMs - start);
        starts.delete(key);
      }
    }
    return intervals;
  }

  let startMs: number | null = null;

  for (const marker of markers) {
    if (marker.event === startEvent) {
      startMs = marker.mainMonotonicMs;
      continue;
    }
    if (endEvents.has(marker.event) && startMs !== null) {
      intervals.push(marker.mainMonotonicMs - startMs);
      startMs = null;
    }
  }

  return intervals;
}

export type LatencySummary = {
  count: number;
  failures: number;
  p50: number;
  p95: number;
  max: number;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const position = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower] ?? 0;
  }
  const weight = position - lower;
  const interpolated = (sorted[lower] ?? 0) + weight * ((sorted[upper] ?? 0) - (sorted[lower] ?? 0));
  return Math.round(interpolated);
}

export function summarizeLatency(samples: number[], expectedCount: number): LatencySummary {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    failures: Math.max(0, expectedCount - sorted.length),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export function buildMarkerSummary(markers: PerformanceMarker[]): Record<string, LatencySummary> {
  const definitions: Array<{
    name: string;
    start: string;
    end: string | string[];
    scenarios: string[] | 'when-present';
    correlationField?: keyof PerformanceMarker;
    surface?: string;
  }> = [
    {
      name: 'main-runtime-initialization',
      start: 'app.electron-ready',
      end: 'runtime.operational',
      scenarios: 'when-present',
    },
    {
      name: 'recording-activation',
      start: 'hotkey.detected',
      end: 'audio.capture.started',
      scenarios: ['dictation-recording'],
      correlationField: 'recordingSessionId',
    },
    {
      name: 'recording-complete',
      start: 'recording.stop.requested',
      end: 'recording.session.completed',
      scenarios: ['dictation-recording'],
      correlationField: 'recordingSessionId',
    },
    {
      name: 'settings-open',
      start: 'surface.requested',
      end: 'surface.paint-proxy',
      scenarios: ['settings-open'],
      surface: 'settings',
    },
    {
      name: 'mcp-connect-discovery',
      start: 'mcp.connect.requested',
      end: 'mcp.tools.discovered',
      scenarios: ['mcp-stdio-tool', 'mcp-http-tool'],
      correlationField: 'serverId',
    },
    {
      name: 'mcp-first-tool',
      start: 'agent.run.requested',
      end: 'mcp.tool.execute.started',
      scenarios: ['mcp-stdio-tool', 'mcp-http-tool'],
      correlationField: 'agentRunId',
    },
    {
      name: 'mcp-tool-execution',
      start: 'mcp.tool.execute.started',
      end: 'mcp.tool.execute.result',
      scenarios: ['mcp-stdio-tool', 'mcp-http-tool'],
      correlationField: 'agentRunId',
    },
    {
      name: 'agent-first-outcome',
      start: 'agent.run.requested',
      end: [
        'agent.response.first-delta',
        'approval.requested',
        'agent.completed',
        'agent.failed',
        'agent.cancelled',
      ],
      scenarios: ['agent-no-mcp', 'mcp-stdio-tool', 'mcp-http-tool'],
      correlationField: 'agentRunId',
    },
  ];

  const scenarioIds = new Set(markers.map((marker) => marker.scenarioId));
  const expectedRuns = Math.max(1, new Set(markers.map((marker) => marker.runId)).size);
  const summary: Record<string, LatencySummary> = {};
  for (const definition of definitions) {
    const applicable = definition.scenarios === 'when-present'
      ? markers.some((marker) => marker.event === definition.start || (
        Array.isArray(definition.end)
          ? definition.end.includes(marker.event)
          : marker.event === definition.end
      ))
      : definition.scenarios.some((scenarioId) => scenarioIds.has(scenarioId));
    if (!applicable) continue;
    const metricMarkers = definition.surface
      ? markers.filter((marker) => marker.surface === definition.surface)
      : markers;
    const samples = definition.name === 'recording-activation'
      ? correlateRecordingActivation(markers)
      : correlateMarkerIntervals(metricMarkers, definition.start, definition.end, {
        correlationField: definition.correlationField,
      });
    summary[definition.name] = summarizeLatency(
      samples,
      expectedRuns,
    );
  }
  return summary;
}

function correlateRecordingActivation(markers: PerformanceMarker[]): number[] {
  const bySession = new Map<string, { start?: number; capture?: number; paint?: number }>();
  for (const marker of markers) {
    if (!marker.recordingSessionId) continue;
    const key = `${marker.runId}:${marker.recordingSessionId}`;
    const state = bySession.get(key) ?? {};
    if (marker.event === 'hotkey.detected') state.start = marker.mainMonotonicMs;
    if (marker.event === 'audio.capture.started') state.capture = marker.mainMonotonicMs;
    if (marker.event === 'surface.paint-proxy' && marker.surface === 'recording') {
      state.paint = marker.mainMonotonicMs;
    }
    bySession.set(key, state);
  }

  return [...bySession.values()].flatMap((state) => {
    if (state.start === undefined || state.capture === undefined || state.paint === undefined) return [];
    return [Math.max(state.capture, state.paint) - state.start];
  });
}
