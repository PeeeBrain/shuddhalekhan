import { describe, expect, it } from 'bun:test';
import { aggregateLatencyObservations } from '../performance/aggregate-summary';

describe('aggregateLatencyObservations', () => {
  it('reports per-build distributions, failures, A/A noise, and candidate deltas', () => {
    expect(aggregateLatencyObservations([
      { buildLabel: 'baseline', metric: 'cold-startup', value: 100 },
      { buildLabel: 'baseline', metric: 'cold-startup', value: 120 },
      { buildLabel: 'baseline', metric: 'cold-startup', failed: true },
      { buildLabel: 'candidate', metric: 'cold-startup', value: 130 },
      { buildLabel: 'candidate', metric: 'cold-startup', value: 150 },
    ], { baselineLabel: 'baseline', candidateLabel: 'candidate' })).toEqual({
      byBuild: {
        baseline: {
          'cold-startup': { count: 2, failures: 1, p50: 110, p95: 119, max: 120, mad: 10 },
        },
        candidate: {
          'cold-startup': { count: 2, failures: 0, p50: 140, p95: 149, max: 150, mad: 10 },
        },
      },
      deltas: {
        'cold-startup': { p50: 30, p95: 30, max: 30 },
      },
    });
  });
});
