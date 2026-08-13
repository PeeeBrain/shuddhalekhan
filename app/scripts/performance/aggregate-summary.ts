export type LatencyObservation = {
  buildLabel: string;
  metric: string;
  value?: number;
  failed?: boolean;
};

type AggregateLatency = {
  count: number;
  failures: number;
  p50: number;
  p95: number;
  max: number;
  mad: number;
};

export function aggregateLatencyObservations(
  observations: LatencyObservation[],
  labels: { baselineLabel: string; candidateLabel: string },
): {
  byBuild: Record<string, Record<string, AggregateLatency>>;
  deltas: Record<string, { p50: number; p95: number; max: number }>;
} {
  const grouped = new Map<string, Map<string, { values: number[]; failures: number }>>();
  for (const observation of observations) {
    const byMetric = grouped.get(observation.buildLabel) ?? new Map();
    const group = byMetric.get(observation.metric) ?? { values: [], failures: 0 };
    if (observation.failed || observation.value === undefined) group.failures += 1;
    else group.values.push(observation.value);
    byMetric.set(observation.metric, group);
    grouped.set(observation.buildLabel, byMetric);
  }

  const byBuild: Record<string, Record<string, AggregateLatency>> = {};
  for (const [buildLabel, byMetric] of grouped) {
    byBuild[buildLabel] = Object.fromEntries([...byMetric].map(([metric, group]) => [
      metric,
      aggregate(group.values, group.failures),
    ]));
  }

  const deltas: Record<string, { p50: number; p95: number; max: number }> = {};
  const baseline = byBuild[labels.baselineLabel] ?? {};
  const candidate = byBuild[labels.candidateLabel] ?? {};
  for (const metric of Object.keys(baseline)) {
    const baselineMetric = baseline[metric];
    const candidateMetric = candidate[metric];
    if (!baselineMetric || !candidateMetric) continue;
    deltas[metric] = {
      p50: candidateMetric.p50 - baselineMetric.p50,
      p95: candidateMetric.p95 - baselineMetric.p95,
      max: candidateMetric.max - baselineMetric.max,
    };
  }

  return { byBuild, deltas };
}

function aggregate(values: number[], failures: number): AggregateLatency {
  const sorted = [...values].sort((left, right) => left - right);
  const median = percentile(sorted, 50);
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((left, right) => left - right);
  return {
    count: sorted.length,
    failures,
    p50: median,
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
    mad: percentile(deviations, 50),
  };
}

function percentile(sorted: number[], percentage: number): number {
  if (sorted.length === 0) return 0;
  const position = (percentage / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? 0;
  const weight = position - lower;
  return (sorted[lower] ?? 0) + weight * ((sorted[upper] ?? 0) - (sorted[lower] ?? 0));
}
