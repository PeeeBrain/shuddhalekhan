import { readFileSync } from 'fs';
import { join } from 'path';
import type { AppConfig, McpServerConfig } from '../../types/ipc';
import { emitPerformanceMarker, setPerformanceMarkerContext } from './marker-collector';

export type PerformanceScenarioId =
  | 'dictation-idle'
  | 'dictation-recording'
  | 'settings-open'
  | 'agent-no-mcp'
  | 'mcp-stdio-tool'
  | 'mcp-http-tool';

export type PerformanceScenarioDriverConfig =
  | { enabled: false }
  | {
      enabled: true;
      scenarioId: PerformanceScenarioId;
      fixtureRoot: string;
      providerBaseUrl: string;
      mcpHttpUrl: string;
      warmupRepetitions?: number;
      actionRepetitions?: number;
    };

type EnabledDriverConfig = Extract<PerformanceScenarioDriverConfig, { enabled: true }>;

export interface PerformanceScenarioDriverDeps {
  openSettings: () => void | Promise<void>;
  runRecording: (fixture: {
    wav: Uint8Array;
    playbackDurationMs: number;
    transcriptionEndpoint: string;
  }) => Promise<unknown>;
  runAgent: (fixture: { transcript: string; config: AppConfig }) => void | Promise<void>;
  getConfig: () => AppConfig;
  emitMarker?: typeof emitPerformanceMarker;
  setMarkerContext?: typeof setPerformanceMarkerContext;
}

const SUPPORTED_SCENARIOS = new Set<PerformanceScenarioId>([
  'dictation-idle',
  'dictation-recording',
  'settings-open',
  'agent-no-mcp',
  'mcp-stdio-tool',
  'mcp-http-tool',
]);

export function isPerformanceScenarioDriverEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.SHUDDHALEKHAN_PERF_MARKERS === '1' && env.SHUDDHALEKHAN_PERF_DRIVER === '1';
}

export function isolatePerformanceDriverConfig(config: AppConfig, env: NodeJS.ProcessEnv): AppConfig {
  if (!isPerformanceScenarioDriverEnabled(env)) return config;
  return {
    ...config,
    agent: {
      ...config.agent,
      enabled: false,
      mcpServers: [],
    },
  };
}

export function parsePerformanceScenarioDriverConfig(
  env: NodeJS.ProcessEnv,
): PerformanceScenarioDriverConfig {
  if (!isPerformanceScenarioDriverEnabled(env)) {
    return { enabled: false };
  }

  const scenarioId = env.SHUDDHALEKHAN_PERF_SCENARIO_ID as PerformanceScenarioId | undefined;
  if (!scenarioId || !SUPPORTED_SCENARIOS.has(scenarioId)) {
    throw new Error(`Unsupported performance scenario: ${scenarioId ?? '(missing)'}`);
  }

  const fixtureRoot = env.SHUDDHALEKHAN_PERF_FIXTURE_ROOT?.trim() ?? '';
  const providerBaseUrl = env.SHUDDHALEKHAN_PERF_PROVIDER_BASE_URL?.trim() ?? '';
  const mcpHttpUrl = env.SHUDDHALEKHAN_PERF_MCP_HTTP_URL?.trim() ?? '';
  const warmupRepetitions = parseRepetitionCount(
    env.SHUDDHALEKHAN_PERF_WARMUP_REPETITIONS,
    0,
    'warmup repetitions',
  );
  const actionRepetitions = parseRepetitionCount(
    env.SHUDDHALEKHAN_PERF_ACTION_REPETITIONS,
    1,
    'action repetitions',
  );

  if (['dictation-recording', 'mcp-stdio-tool'].includes(scenarioId) && !fixtureRoot) {
    throw new Error(`Performance scenario ${scenarioId} requires a fixture root.`);
  }
  if (['dictation-recording', 'agent-no-mcp', 'mcp-stdio-tool', 'mcp-http-tool'].includes(scenarioId)
    && !providerBaseUrl) {
    throw new Error(`Performance scenario ${scenarioId} requires a provider base URL.`);
  }
  if (scenarioId === 'mcp-http-tool' && !mcpHttpUrl) {
    throw new Error('Performance scenario mcp-http-tool requires an MCP HTTP URL.');
  }

  return {
    enabled: true,
    scenarioId,
    fixtureRoot,
    providerBaseUrl,
    mcpHttpUrl,
    warmupRepetitions,
    actionRepetitions,
  };
}

function parseRepetitionCount(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || (label === 'action repetitions' && parsed < 1)) {
    throw new Error(`Performance ${label} must be ${label === 'action repetitions' ? 'a positive' : 'a non-negative'} integer.`);
  }
  return parsed;
}

export function buildBenchmarkAgentConfig(
  base: AppConfig,
  fixture: Pick<EnabledDriverConfig, 'scenarioId' | 'fixtureRoot' | 'providerBaseUrl' | 'mcpHttpUrl'>,
): AppConfig {
  const mcpServer = buildMcpServer(fixture);
  return {
    ...base,
    agent: {
      ...base.agent,
      enabled: true,
      provider: {
        baseUrl: fixture.providerBaseUrl,
        model: 'benchmark-fixture-v1',
        apiKeyEnvVar: '',
        apiKeySource: 'environment',
        thinkingEnabled: false,
        reasoningEffort: 'low',
      },
      mcpServers: mcpServer ? [mcpServer] : [],
    },
  };
}

function buildMcpServer(
  fixture: Pick<EnabledDriverConfig, 'scenarioId' | 'fixtureRoot' | 'mcpHttpUrl'>,
): McpServerConfig | null {
  if (fixture.scenarioId !== 'mcp-stdio-tool' && fixture.scenarioId !== 'mcp-http-tool') {
    return null;
  }
  return {
    id: 'benchmark-echo',
    displayName: 'Benchmark Echo',
    enabled: true,
    transport: fixture.scenarioId === 'mcp-stdio-tool'
      ? {
          type: 'stdio',
          command: process.platform === 'win32' ? 'bun.exe' : 'bun',
          args: [join(fixture.fixtureRoot, 'mcp-stdio-server.ts')],
          envVarNames: [],
        }
      : {
          type: 'http',
          url: fixture.mcpHttpUrl,
          redirect: 'error',
        },
    discoveredTools: [],
    toolPolicies: { 'benchmark-echo:echo': 'alwaysAllow' },
  };
}

export function createPerformanceScenarioDriver(
  config: PerformanceScenarioDriverConfig,
  deps: PerformanceScenarioDriverDeps,
): { start: () => Promise<void> } {
  let started = false;
  const emitMarker = deps.emitMarker ?? emitPerformanceMarker;
  const setMarkerContext = deps.setMarkerContext ?? setPerformanceMarkerContext;
  return {
    async start() {
      if (!config.enabled || started) return;
      started = true;
      try {
        const phases = [
          { phase: 'warmup' as const, repetitions: config.warmupRepetitions ?? 0 },
          { phase: 'measured' as const, repetitions: config.actionRepetitions ?? 1 },
        ];
        for (const { phase, repetitions } of phases) {
          for (let iteration = 1; iteration <= repetitions; iteration += 1) {
            setMarkerContext({ benchmarkPhase: phase, benchmarkIteration: iteration });
            emitMarker('scenario.action.requested', { scenario: config.scenarioId });
            if (config.scenarioId === 'settings-open') {
              await deps.openSettings();
            } else if (config.scenarioId === 'dictation-recording') {
              const pcm = readFileSync(join(config.fixtureRoot, 'canonical-utterance-v1.pcm'));
              await deps.runRecording({
                wav: wrapPcm16LeAsWav(pcm, 16_000),
                playbackDurationMs: (pcm.byteLength / 2 / 16_000) * 1_000,
                transcriptionEndpoint: new URL('/inference', config.providerBaseUrl).toString(),
              });
            } else if (config.scenarioId !== 'dictation-idle') {
              await deps.runAgent({
                transcript: config.scenarioId === 'agent-no-mcp'
                  ? 'Reply with exactly: benchmark complete'
                  : 'Use the echo tool with the message benchmark, then reply with exactly: benchmark complete',
                config: buildBenchmarkAgentConfig(deps.getConfig(), config),
              });
            }
          }
        }
        setMarkerContext();
        emitMarker('scenario.action.dispatched', { scenario: config.scenarioId });
      } catch (error) {
        setMarkerContext();
        emitMarker('scenario.action.failed', {
          scenario: config.scenarioId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        throw error;
      }
    },
  };
}

export function wrapPcm16LeAsWav(pcm: Uint8Array, sampleRateHz: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}
