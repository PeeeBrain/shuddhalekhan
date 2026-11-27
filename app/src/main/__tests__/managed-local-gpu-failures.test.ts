import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createGpuFailureRecord, type GpuIdentity } from '../managed-local-gpu-failures';

const path = join(tmpdir(), `shuddhalekhan-gpu-failure-record-${process.pid}.json`);
const open = (identity: GpuIdentity | null = { device: 'GPU-1', driver: '580.1' }) =>
  createGpuFailureRecord({ getPath: () => path, getIdentity: async () => identity });
afterEach(() => rmSync(path, { force: true }));

describe('Managed Local GPU failure record', () => {
  it('reads a corrupt file as no failures and replaces it on the next failure', async () => {
    writeFileSync(path, '{"not": "a list"');
    expect(await open().has('parakeet')).toBe(false);
    await open().record('parakeet', 'CUDA initialization failed');
    expect(await open().has('parakeet')).toBe(true);
  });

  it('keeps only the newest failures', async () => {
    for (let index = 0; index < 20; index++) await open({ device: `GPU-${index}`, driver: '580.1' }).record('parakeet', 'failed');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(16);
    expect(await open({ device: 'GPU-19', driver: '580.1' }).has('parakeet')).toBe(true);
    expect(await open({ device: 'GPU-0', driver: '580.1' }).has('parakeet')).toBe(false);
  });

  it('remembers a failure without a device identity for this launch only', async () => {
    const record = open(null);
    await record.record('parakeet', 'CUDA initialization failed');
    expect(await record.has('parakeet')).toBe(true);
    expect(await open(null).has('parakeet')).toBe(false);
  });
});
