import { availableParallelism } from 'os';

export function getManagedLocalThreadLimits() {
  const maxThreads = availableParallelism();
  return { maxThreads, defaultThreads: Math.max(1, Math.min(4, maxThreads - 1)) };
}

export function isManagedLocalThreadCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= 1 && value <= availableParallelism();
}

export function resolveManagedLocalThreads(value: unknown): number {
  return isManagedLocalThreadCount(value) ? value : getManagedLocalThreadLimits().defaultThreads;
}
