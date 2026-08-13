import { summarizeLatency, type LatencySummary } from './summarize-markers';

export type ExternalPerformanceEvent = {
  schemaVersion: 1;
  runId: string;
  scenarioId: string;
  sequence: number;
  event: string;
  qpcTicks: number;
  qpcFrequency: number;
  utc: string;
  pid?: number;
};

export function parseExternalEventStream(content: string): ExternalPerformanceEvent[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ExternalPerformanceEvent);
}

export function buildExternalMarkerSummary(
  events: ExternalPerformanceEvent[],
): Record<string, LatencySummary> {
  if (events.length === 0) return {};

  const starts = new Map<string, ExternalPerformanceEvent>();
  const samples: number[] = [];
  for (const event of events) {
    if (event.event === 'process.launch.requested') {
      starts.set(event.runId, event);
      continue;
    }
    if (event.event !== 'runtime.operational.received') continue;
    const start = starts.get(event.runId);
    if (!start || start.qpcFrequency !== event.qpcFrequency) continue;
    samples.push(((event.qpcTicks - start.qpcTicks) * 1000) / event.qpcFrequency);
    starts.delete(event.runId);
  }

  const expectedRuns = new Set(events.map((event) => event.runId)).size;
  return { 'cold-startup': summarizeLatency(samples, expectedRuns) };
}
