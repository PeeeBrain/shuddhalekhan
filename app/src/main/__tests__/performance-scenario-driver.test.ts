import { describe, expect, it, mock } from 'bun:test';
import { join } from 'path';
import type { AppConfig } from '../../types/ipc';
import {
  buildBenchmarkAgentConfig,
  createPerformanceScenarioDriver,
  isolatePerformanceDriverConfig,
  parsePerformanceScenarioDriverConfig,
  wrapPcm16LeAsWav,
} from '../performance/scenario-driver';

const baseConfig = {
  agent: {
    enabled: false,
    provider: {
      baseUrl: '',
      model: '',
      apiKeyEnvVar: '',
      apiKeySource: 'environment',
      thinkingEnabled: true,
      reasoningEffort: 'medium',
    },
    mcpServers: [],
  },
} as unknown as AppConfig;

describe('parsePerformanceScenarioDriverConfig', () => {
  it('stays disabled unless markers and the separate driver gate are both enabled', () => {
    expect(parsePerformanceScenarioDriverConfig({ SHUDDHALEKHAN_PERF_DRIVER: '1' })).toEqual({ enabled: false });
    expect(parsePerformanceScenarioDriverConfig({ SHUDDHALEKHAN_PERF_MARKERS: '1' })).toEqual({ enabled: false });
  });

  it('requires fixture endpoints for action scenarios', () => {
    expect(() => parsePerformanceScenarioDriverConfig({
      SHUDDHALEKHAN_PERF_MARKERS: '1',
      SHUDDHALEKHAN_PERF_DRIVER: '1',
      SHUDDHALEKHAN_PERF_SCENARIO_ID: 'mcp-stdio-tool',
    })).toThrow('fixture root');
  });
});

describe('buildBenchmarkAgentConfig', () => {
  it('constructs an in-memory stdio MCP fixture without changing the persisted base config', () => {
    const fixtureRoot = 'D:\\fixtures';
    const config = buildBenchmarkAgentConfig(baseConfig, {
      scenarioId: 'mcp-stdio-tool',
      providerBaseUrl: 'http://127.0.0.1:43175/v1',
      fixtureRoot,
      mcpHttpUrl: 'http://127.0.0.1:43176/mcp',
    });

    expect(config.agent.enabled).toBe(true);
    expect(config.agent.provider).toMatchObject({
      baseUrl: 'http://127.0.0.1:43175/v1',
      model: 'benchmark-fixture-v1',
      thinkingEnabled: false,
    });
    expect(config.agent.mcpServers).toEqual([{
      id: 'benchmark-echo',
      displayName: 'Benchmark Echo',
      enabled: true,
      transport: {
        type: 'stdio',
        command: process.platform === 'win32' ? 'bun.exe' : 'bun',
        args: [join(fixtureRoot, 'mcp-stdio-server.ts')],
        envVarNames: [],
      },
      discoveredTools: [],
      toolPolicies: { 'benchmark-echo:echo': 'alwaysAllow' },
    }]);
    expect(baseConfig.agent.enabled).toBe(false);
  });
});

describe('isolatePerformanceDriverConfig', () => {
  it('disables persisted Agent and MCP state without mutating the stored config object', () => {
    const configured = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        enabled: true,
        mcpServers: [{ id: 'personal-server' }],
      },
    } as AppConfig;

    const isolated = isolatePerformanceDriverConfig(configured, {
      SHUDDHALEKHAN_PERF_MARKERS: '1',
      SHUDDHALEKHAN_PERF_DRIVER: '1',
    });

    expect(isolated.agent.enabled).toBe(false);
    expect(isolated.agent.mcpServers).toEqual([]);
    expect(configured.agent.enabled).toBe(true);
    expect(configured.agent.mcpServers).toHaveLength(1);
  });
});

describe('createPerformanceScenarioDriver', () => {
  it('dispatches the configured scenario once after runtime readiness', async () => {
    const openSettings = mock(() => undefined);
    const runRecording = mock(async () => undefined);
    const runAgent = mock(() => undefined);
    const driver = createPerformanceScenarioDriver(
      { enabled: true, scenarioId: 'settings-open', fixtureRoot: '', providerBaseUrl: '', mcpHttpUrl: '' },
      { openSettings, runRecording, runAgent, getConfig: () => baseConfig },
    );

    await driver.start();
    await driver.start();

    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(runRecording).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('runs declared warmups before measured repetitions and tags their marker context', async () => {
    const contexts: unknown[] = [];
    const openSettings = mock(async () => undefined);
    const driver = createPerformanceScenarioDriver(
      {
        enabled: true,
        scenarioId: 'settings-open',
        fixtureRoot: '',
        providerBaseUrl: '',
        mcpHttpUrl: '',
        warmupRepetitions: 2,
        actionRepetitions: 3,
      },
      {
        openSettings,
        runRecording: async () => undefined,
        runAgent: async () => undefined,
        getConfig: () => baseConfig,
        setMarkerContext: (context) => { contexts.push(context); },
      },
    );

    await driver.start();

    expect(openSettings).toHaveBeenCalledTimes(5);
    expect(contexts).toEqual([
      { benchmarkPhase: 'warmup', benchmarkIteration: 1 },
      { benchmarkPhase: 'warmup', benchmarkIteration: 2 },
      { benchmarkPhase: 'measured', benchmarkIteration: 1 },
      { benchmarkPhase: 'measured', benchmarkIteration: 2 },
      { benchmarkPhase: 'measured', benchmarkIteration: 3 },
      undefined,
    ]);
  });
});

describe('wrapPcm16LeAsWav', () => {
  it('creates a valid mono 16 kHz PCM WAV around the pinned raw samples', () => {
    const pcm = Buffer.from([1, 0, 2, 0]);
    const wav = wrapPcm16LeAsWav(pcm, 16_000);

    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.subarray(44)).toEqual(pcm);
  });
});
