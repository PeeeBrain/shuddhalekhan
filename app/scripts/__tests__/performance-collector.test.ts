import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseProcessSampleCsv } from '../performance/process-sample';

describe('performance-collector.ps1', () => {
  it('samples only explicit process identities with their declared roles', async () => {
    if (process.platform !== 'win32') return;

    const outputDir = mkdtempSync(join(tmpdir(), 'shuddhalekhan-collector-'));
    const rolesPath = join(outputDir, 'process-roles.json');
    writeFileSync(rolesPath, `${JSON.stringify({
      schemaVersion: 1,
      processes: [{ pid: process.pid, role: 'electron-main' }],
    })}\n`);

    const result = Bun.spawnSync([
      'pwsh',
      '-NoProfile',
      '-File',
      join(import.meta.dir, '..', 'performance-collector.ps1'),
      '-OutputDir',
      outputDir,
      '-SampleCount',
      '2',
      '-SampleIntervalMs',
      '50',
      '-ProcessRolesPath',
      rolesPath,
    ]);

    expect(result.exitCode).toBe(0);
    const samples = parseProcessSampleCsv(await Bun.file(join(outputDir, 'process-samples.csv')).text());
    expect(samples.map(({ sampleIndex, pid, role }) => ({ sampleIndex, pid, role }))).toEqual([
      { sampleIndex: 0, pid: process.pid, role: 'electron-main' },
      { sampleIndex: 1, pid: process.pid, role: 'electron-main' },
    ]);
  });

  it('derives CPU percentage from QPC elapsed time at non-default intervals', async () => {
    if (process.platform !== 'win32') return;

    const worker = Bun.spawn([
      'pwsh',
      '-NoProfile',
      '-Command',
      '$deadline = [DateTime]::UtcNow.AddSeconds(10); while ([DateTime]::UtcNow -lt $deadline) { $value = [Math]::Sqrt(12345.6789) }',
    ], { stdout: 'ignore', stderr: 'ignore' });
    const outputDir = mkdtempSync(join(tmpdir(), 'shuddhalekhan-collector-cpu-'));
    const rolesPath = join(outputDir, 'process-roles.json');
    writeFileSync(rolesPath, `${JSON.stringify({
      schemaVersion: 1,
      processes: [{ pid: worker.pid, role: 'agent-sidecar' }],
    })}\n`);

    try {
      const result = Bun.spawnSync([
        'pwsh',
        '-NoProfile',
        '-File',
        join(import.meta.dir, '..', 'performance-collector.ps1'),
        '-OutputDir',
        outputDir,
        '-SampleCount',
        '4',
        '-SampleIntervalMs',
        '250',
        '-ProcessRolesPath',
        rolesPath,
      ]);
      expect(result.exitCode).toBe(0);

      const samples = parseProcessSampleCsv(await Bun.file(join(outputDir, 'process-samples.csv')).text());
      const metadata = await Bun.file(join(outputDir, 'metadata.json')).json() as {
        logicalProcessorCount: number;
      };
      expect(metadata.logicalProcessorCount).toBeGreaterThan(0);
      const expectedSingleCoreHostPercent = 100 / metadata.logicalProcessorCount;
      expect(Math.max(...samples.slice(1).map((sample) => sample.cpuPercent)))
        .toBeGreaterThan(expectedSingleCoreHostPercent * 0.5);
    } finally {
      worker.kill();
      await worker.exited;
    }
  });

  it('rejects a PID whose creation time does not match the declared identity', async () => {
    if (process.platform !== 'win32') return;

    const outputDir = mkdtempSync(join(tmpdir(), 'shuddhalekhan-collector-identity-'));
    const rolesPath = join(outputDir, 'process-roles.json');
    writeFileSync(rolesPath, `${JSON.stringify({
      schemaVersion: 1,
      processes: [{
        pid: process.pid,
        creationTime: '2000-01-01T00:00:00.000Z',
        role: 'electron-main',
      }],
    })}\n`);

    const result = Bun.spawnSync([
      'pwsh',
      '-NoProfile',
      '-File',
      join(import.meta.dir, '..', 'performance-collector.ps1'),
      '-OutputDir',
      outputDir,
      '-SampleCount',
      '1',
      '-SampleIntervalMs',
      '10',
      '-ProcessRolesPath',
      rolesPath,
    ]);

    expect(result.exitCode).toBe(0);
    const samples = parseProcessSampleCsv(await Bun.file(join(outputDir, 'process-samples.csv')).text());
    expect(samples).toEqual([]);
  });

  it('does not sweep unrelated Bun processes when descendant tracking is enabled', async () => {
    if (process.platform !== 'win32') return;

    const watched = Bun.spawn([
      'pwsh',
      '-NoProfile',
      '-Command',
      'Start-Sleep -Seconds 10',
    ], { stdout: 'ignore', stderr: 'ignore' });
    const unrelated = Bun.spawn([
      process.execPath,
      '-e',
      'setTimeout(() => {}, 10000)',
    ], { stdout: 'ignore', stderr: 'ignore' });
    const outputDir = mkdtempSync(join(tmpdir(), 'shuddhalekhan-collector-scope-'));
    const rolesPath = join(outputDir, 'process-roles.json');
    writeFileSync(rolesPath, `${JSON.stringify({
      schemaVersion: 1,
      processes: [{ pid: watched.pid, role: 'electron-main' }],
    })}\n`);

    try {
      const result = Bun.spawnSync([
        'pwsh',
        '-NoProfile',
        '-File',
        join(import.meta.dir, '..', 'performance-collector.ps1'),
        '-OutputDir',
        outputDir,
        '-SampleCount',
        '1',
        '-SampleIntervalMs',
        '10',
        '-ProcessRolesPath',
        rolesPath,
        '-IncludeRelatedProcesses',
      ]);
      expect(result.exitCode).toBe(0);

      const samples = parseProcessSampleCsv(await Bun.file(join(outputDir, 'process-samples.csv')).text());
      expect(samples.map((sample) => sample.pid)).toEqual([watched.pid]);
      expect(samples.some((sample) => sample.pid === unrelated.pid)).toBe(false);
    } finally {
      watched.kill();
      unrelated.kill();
      await Promise.all([watched.exited, unrelated.exited]);
    }
  });

  it('keeps descendants in their explicitly declared process group', async () => {
    if (process.platform !== 'win32') return;

    const root = Bun.spawn([
      'pwsh',
      '-NoProfile',
      '-Command',
      "$child = Start-Process pwsh -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 10' -PassThru -WindowStyle Hidden; Write-Output $child.Id; Wait-Process -Id $child.Id",
    ], { stdout: 'pipe', stderr: 'ignore' });
    const reader = root.stdout.getReader();
    const firstChunk = await reader.read();
    const childPid = Number(new TextDecoder().decode(firstChunk.value).trim());
    expect(childPid).toBeGreaterThan(0);

    const outputDir = mkdtempSync(join(tmpdir(), 'shuddhalekhan-collector-tree-'));
    const rolesPath = join(outputDir, 'process-roles.json');
    writeFileSync(rolesPath, `${JSON.stringify({
      schemaVersion: 1,
      processes: [{ pid: root.pid, role: 'mcp:echo', includeDescendants: true }],
    })}\n`);

    try {
      const result = Bun.spawnSync([
        'pwsh',
        '-NoProfile',
        '-File',
        join(import.meta.dir, '..', 'performance-collector.ps1'),
        '-OutputDir',
        outputDir,
        '-SampleCount',
        '1',
        '-SampleIntervalMs',
        '10',
        '-ProcessRolesPath',
        rolesPath,
        '-IncludeRelatedProcesses',
      ]);
      expect(result.exitCode).toBe(0);

      const samples = parseProcessSampleCsv(await Bun.file(join(outputDir, 'process-samples.csv')).text());
      expect(samples.some((sample) => sample.pid === root.pid)).toBe(true);
      expect(samples.some((sample) => sample.pid === childPid)).toBe(true);
      expect(new Set(samples.map((sample) => sample.role))).toEqual(new Set(['mcp:echo']));
    } finally {
      root.kill();
      Bun.spawnSync(['pwsh', '-NoProfile', '-Command', `Stop-Process -Id ${childPid} -Force -ErrorAction SilentlyContinue`]);
      await root.exited;
    }
  }, 15_000);

  it('honors declared subtree boundaries instead of sweeping through an explicit child root', async () => {
    if (process.platform !== 'win32') return;

    const sidecar = Bun.spawn([
      process.execPath,
      '-e',
      "const grandchild = Bun.spawn(['pwsh','-NoProfile','-Command','Start-Sleep -Seconds 10']); console.log(grandchild.pid); await grandchild.exited;",
    ], { stdout: 'pipe', stderr: 'ignore' });
    const reader = sidecar.stdout.getReader();
    const firstChunk = await reader.read();
    const grandchildPid = Number(new TextDecoder().decode(firstChunk.value).trim());
    expect(grandchildPid).toBeGreaterThan(0);

    const outputDir = mkdtempSync(join(tmpdir(), 'shuddhalekhan-collector-nested-tree-'));
    const rolesPath = join(outputDir, 'process-roles.json');
    writeFileSync(rolesPath, `${JSON.stringify({
      schemaVersion: 1,
      processes: [
        { pid: sidecar.pid, role: 'agent-sidecar', includeDescendants: false },
        { pid: process.pid, role: 'electron-main', includeDescendants: true },
      ],
    })}\n`);

    try {
      const result = Bun.spawnSync([
        'pwsh',
        '-NoProfile',
        '-File',
        join(import.meta.dir, '..', 'performance-collector.ps1'),
        '-OutputDir',
        outputDir,
        '-SampleCount',
        '1',
        '-SampleIntervalMs',
        '10',
        '-ProcessRolesPath',
        rolesPath,
        '-IncludeRelatedProcesses',
      ]);
      expect(result.exitCode).toBe(0);

      const samples = parseProcessSampleCsv(await Bun.file(join(outputDir, 'process-samples.csv')).text());
      expect(samples.find((sample) => sample.pid === sidecar.pid)?.role).toBe('agent-sidecar');
      expect(samples.find((sample) => sample.pid === grandchildPid)).toBeUndefined();
    } finally {
      sidecar.kill();
      Bun.spawnSync(['pwsh', '-NoProfile', '-Command', `Stop-Process -Id ${grandchildPid} -Force -ErrorAction SilentlyContinue`]);
      await sidecar.exited;
    }
  }, 15_000);

  it('captures Docker and NVIDIA samples at the process sample QPC point', async () => {
    if (process.platform !== 'win32') return;

    const outputDir = mkdtempSync(join(tmpdir(), 'shuddhalekhan-collector-accelerators-'));
    const rolesPath = join(outputDir, 'process-roles.json');
    const dockerCommand = join(outputDir, 'fake-docker.cmd');
    const nvidiaCommand = join(outputDir, 'fake-nvidia-smi.ps1');
    writeFileSync(rolesPath, `${JSON.stringify({
      schemaVersion: 1,
      processes: [{ pid: process.pid, role: 'electron-main' }],
    })}\n`);
    writeFileSync(dockerCommand, '@echo off\r\n@if "%1"=="inspect" (@echo sha256:image-fixture& @exit /b 0)\r\n@echo {"CPUPerc":"1.25%%","MemUsage":"64MiB / 1GiB","NetIO":"1kB / 2kB","BlockIO":"3kB / 4kB","PIDs":"7"}\r\n');
    writeFileSync(nvidiaCommand, "param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)\nif ($Arguments[0] -eq '--query-gpu=driver_version') { '999.1' } else { 'GPU-fixture, 42, 1024, 8192, 75.5, 55' }\n");

    const result = Bun.spawnSync([
      'pwsh',
      '-NoProfile',
      '-File',
      join(import.meta.dir, '..', 'performance-collector.ps1'),
      '-OutputDir',
      outputDir,
      '-SampleCount',
      '1',
      '-SampleIntervalMs',
      '10',
      '-ProcessRolesPath',
      rolesPath,
      '-DockerContainerId',
      'container-fixture',
      '-DockerCommandPath',
      dockerCommand,
      '-NvidiaSmiPath',
      nvidiaCommand,
    ]);

    expect(result.exitCode).toBe(0);
    const dockerSamples = await Bun.file(join(outputDir, 'docker-samples.csv')).text();
    const gpuSamples = await Bun.file(join(outputDir, 'gpu-samples.csv')).text();
    expect(dockerSamples).toContain('container-fixture,1.25,64MiB,1GiB,1kB,2kB,3kB,4kB,7');
    expect(gpuSamples).toContain('GPU-fixture,42,1024,8192,75.5,55');
    const metadata = await Bun.file(join(outputDir, 'metadata.json')).json();
    expect(metadata.dockerImageDigest).toBe('sha256:image-fixture');
    expect(metadata.nvidiaDriverVersion).toBe('999.1');
  });
});
