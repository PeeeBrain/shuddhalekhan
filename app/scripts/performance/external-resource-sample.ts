import type { DistributionSummary } from './process-sample';

type DockerAccumulator = { cpu: number[]; memory: number[]; pids: number[] };
type GpuAccumulator = { utilization: number[]; memory: number[]; power: number[] };

export function summarizeExternalResources(
  dockerCsv: string,
  gpuCsv: string,
): {
  docker: Record<string, {
    cpuPercent: DistributionSummary;
    memoryUsageBytes: DistributionSummary;
    pids: DistributionSummary;
  }>;
  gpu: Record<string, {
    utilizationPercent: DistributionSummary;
    memoryUsedMiB: DistributionSummary;
    powerWatts: DistributionSummary;
  }>;
} {
  const dockerValues = new Map<string, DockerAccumulator>();
  for (const row of dataRows(dockerCsv)) {
    const containerId = row[4] ?? '';
    if (!containerId) continue;
    const values = dockerValues.get(containerId) ?? { cpu: [], memory: [], pids: [] };
    values.cpu.push(number(row[5]));
    values.memory.push(parseBytes(row[6] ?? '0'));
    values.pids.push(number(row[12]));
    dockerValues.set(containerId, values);
  }

  const gpuValues = new Map<string, GpuAccumulator>();
  for (const row of dataRows(gpuCsv)) {
    const uuid = row[4] ?? '';
    if (!uuid) continue;
    const values = gpuValues.get(uuid) ?? { utilization: [], memory: [], power: [] };
    values.utilization.push(number(row[5]));
    values.memory.push(number(row[6]));
    values.power.push(number(row[8]));
    gpuValues.set(uuid, values);
  }

  return {
    docker: Object.fromEntries([...dockerValues].map(([containerId, values]) => [containerId, {
      cpuPercent: distribution(values.cpu),
      memoryUsageBytes: distribution(values.memory),
      pids: distribution(values.pids),
    }])),
    gpu: Object.fromEntries([...gpuValues].map(([uuid, values]) => [uuid, {
      utilizationPercent: distribution(values.utilization),
      memoryUsedMiB: distribution(values.memory),
      powerWatts: distribution(values.power),
    }])),
  };
}

function dataRows(content: string): string[][] {
  return content.trim().split(/\r?\n/).slice(1).filter(Boolean).map((line) => line.split(','));
}

function number(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseBytes(value: string): number {
  const match = value.trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? 'b';
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1_000,
    mb: 1_000_000,
    gb: 1_000_000_000,
    tb: 1_000_000_000_000,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  return amount * (multipliers[unit] ?? 0);
}

function distribution(values: number[]): DistributionSummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
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
