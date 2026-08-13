export type ProcessSample = {
  sampleIndex: number;
  qpcTicks: number;
  qpcFrequency: number;
  utc: string;
  pid: number;
  creationTime: string;
  role: string;
  privateBytes: number;
  workingSet: number;
  handleCount: number;
  threadCount: number;
  cpuPercent: number;
};

export type DistributionSummary = {
  median: number;
  p95: number;
  max: number;
};

export type ProcessInventory = {
  sampleIndex: number;
  processes: Array<Pick<ProcessSample, 'pid' | 'creationTime' | 'role'>>;
};

const PROCESS_SAMPLE_HEADERS = [
  'sampleIndex',
  'qpcTicks',
  'qpcFrequency',
  'utc',
  'pid',
  'creationTime',
  'role',
  'privateBytes',
  'workingSet',
  'handleCount',
  'threadCount',
  'cpuPercent',
] as const;

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  values.push(current);
  return values;
}

function toNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${field}: ${value}`);
  }
  return parsed;
}

export function parseProcessSampleCsv(content: string): ProcessSample[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  const header = parseCsvLine(lines[0]);
  if (header.join(',') !== PROCESS_SAMPLE_HEADERS.join(',')) {
    throw new Error(`Unexpected process sample CSV header: ${header.join(',')}`);
  }

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    if (values.length !== PROCESS_SAMPLE_HEADERS.length) {
      throw new Error(`Malformed process sample row: ${line}`);
    }

    return {
      sampleIndex: toNumber(values[0], 'sampleIndex'),
      qpcTicks: toNumber(values[1], 'qpcTicks'),
      qpcFrequency: toNumber(values[2], 'qpcFrequency'),
      utc: values[3],
      pid: toNumber(values[4], 'pid'),
      creationTime: values[5],
      role: values[6],
      privateBytes: toNumber(values[7], 'privateBytes'),
      workingSet: toNumber(values[8], 'workingSet'),
      handleCount: toNumber(values[9], 'handleCount'),
      threadCount: toNumber(values[10], 'threadCount'),
      cpuPercent: toNumber(values[11], 'cpuPercent'),
    };
  });
}

export function groupPrivateBytesByRole(samples: ProcessSample[]): Record<string, number> {
  return Object.fromEntries(
    Object.entries(summarizeProcessSamples(samples).privateBytesByRole)
      .map(([role, distribution]) => [role, distribution.median]),
  );
}

export function summarizeProcessSamples(samples: ProcessSample[]): {
  privateBytesByRole: Record<string, DistributionSummary>;
  workingSetByRole: Record<string, DistributionSummary>;
  cpuPercentByRole: Record<string, DistributionSummary>;
  inventories: ProcessInventory[];
} {
  const privateBytesBySample = new Map<number, Map<string, number>>();
  const workingSetBySample = new Map<number, Map<string, number>>();
  const cpuPercentBySample = new Map<number, Map<string, number>>();
  const inventoryBySample = new Map<number, ProcessInventory['processes']>();
  const seenCpuIdentities = new Set<string>();
  for (const sample of [...samples].sort((left, right) => left.sampleIndex - right.sampleIndex)) {
    addRoleTotal(privateBytesBySample, sample.sampleIndex, sample.role, sample.privateBytes);
    addRoleTotal(workingSetBySample, sample.sampleIndex, sample.role, sample.workingSet);
    const identity = `${sample.pid}:${sample.creationTime}`;
    if (seenCpuIdentities.has(identity)) {
      addRoleTotal(cpuPercentBySample, sample.sampleIndex, sample.role, sample.cpuPercent);
    } else {
      seenCpuIdentities.add(identity);
    }

    const inventory = inventoryBySample.get(sample.sampleIndex) ?? [];
    inventory.push({ pid: sample.pid, creationTime: sample.creationTime, role: sample.role });
    inventoryBySample.set(sample.sampleIndex, inventory);
  }

  const privateBytesByRole = summarizeRoleTotals(privateBytesBySample);
  const workingSetByRole = summarizeRoleTotals(workingSetBySample);
  const cpuPercentByRole = summarizeRoleTotals(cpuPercentBySample);

  const inventories = [...inventoryBySample.entries()]
    .sort(([left], [right]) => left - right)
    .map(([sampleIndex, processes]) => ({
      sampleIndex,
      processes: [...processes].sort((left, right) => left.pid - right.pid),
    }));

  return { privateBytesByRole, workingSetByRole, cpuPercentByRole, inventories };
}

function addRoleTotal(
  bySample: Map<number, Map<string, number>>,
  sampleIndex: number,
  role: string,
  value: number,
): void {
  const roleTotals = bySample.get(sampleIndex) ?? new Map<string, number>();
  roleTotals.set(role, (roleTotals.get(role) ?? 0) + value);
  bySample.set(sampleIndex, roleTotals);
}

function summarizeRoleTotals(
  bySample: Map<number, Map<string, number>>,
): Record<string, DistributionSummary> {
  const valuesByRole = new Map<string, number[]>();
  for (const roleTotals of bySample.values()) {
    for (const [role, total] of roleTotals) {
      const values = valuesByRole.get(role) ?? [];
      values.push(total);
      valuesByRole.set(role, values);
    }
  }

  return Object.fromEntries([...valuesByRole].map(([role, values]) => {
    const sorted = [...values].sort((left, right) => left - right);
    return [role, {
      median: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted[sorted.length - 1] ?? 0,
    }];
  }));
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
