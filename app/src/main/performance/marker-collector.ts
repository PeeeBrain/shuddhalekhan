import { openSync, writeSync } from 'fs';

export const MARKER_SCHEMA_VERSION = 1 as const;

export const SENSITIVE_MARKER_FIELDS = [
  'transcript',
  'delta',
  'response',
  'arguments',
  'apiKey',
  'secret',
  'password',
  'token',
  'toolResult',
  'env',
] as const;

export type MarkerConfig =
  | { enabled: false }
  | {
      enabled: true;
      runId: string;
      scenarioId: string;
      eventsPath: string;
    };

export type PerformanceMarker = {
  schemaVersion: typeof MARKER_SCHEMA_VERSION;
  runId: string;
  scenarioId: string;
  sequence: number;
  event: string;
  mainMonotonicMs: number;
  utc: string;
  pid: number;
  processRole: 'electron-main';
  recordingSessionId?: string;
  agentRunId?: string;
  serverId?: string;
  surface?: string;
  childPid?: number;
  from?: string;
  to?: string;
  benchmarkPhase?: 'warmup' | 'measured';
  benchmarkIteration?: number;
};

export type MarkerFields = Record<string, unknown>;

const SENSITIVE_MARKER_FIELD_SET = new Set<string>(SENSITIVE_MARKER_FIELDS);

export type MarkerCollector = {
  readonly enabled: boolean;
  emit: (event: string, fields?: MarkerFields) => void;
};

type MarkerClock = {
  pid: number;
  now: () => number;
  utc?: () => string;
  writeLine: (line: string) => void;
};

export function parseMarkerConfig(env: NodeJS.ProcessEnv): MarkerConfig {
  const enabled = env.SHUDDHALEKHAN_PERF_MARKERS === '1';
  if (!enabled) {
    return { enabled: false };
  }

  return {
    enabled: true,
    runId: env.SHUDDHALEKHAN_PERF_RUN_ID ?? 'unspecified-run',
    scenarioId: env.SHUDDHALEKHAN_PERF_SCENARIO_ID ?? 'unspecified-scenario',
    eventsPath: env.SHUDDHALEKHAN_PERF_EVENTS_PATH ?? 'events.jsonl',
  };
}

export function sanitizeMarkerFields(fields: MarkerFields = {}): MarkerFields {
  const sanitized: MarkerFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_MARKER_FIELD_SET.has(key)) {
      continue;
    }
    sanitized[key] = sanitizeMarkerValue(value);
  }
  return sanitized;
}

function sanitizeMarkerValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeMarkerValue);
  }
  if (value && typeof value === 'object') {
    return sanitizeMarkerFields(value as MarkerFields);
  }
  return value;
}

export function createMarkerCollector(config: MarkerConfig, clock: MarkerClock): MarkerCollector {
  if (!config.enabled) {
    return {
      enabled: false,
      emit: () => undefined,
    };
  }

  let sequence = 0;

  return {
    enabled: true,
    emit(event, fields = {}) {
      sequence += 1;
      const marker: PerformanceMarker = {
        ...sanitizeMarkerFields(fields),
        schemaVersion: MARKER_SCHEMA_VERSION,
        runId: config.runId,
        scenarioId: config.scenarioId,
        sequence,
        event,
        mainMonotonicMs: clock.now(),
        utc: clock.utc?.() ?? new Date().toISOString(),
        pid: clock.pid,
        processRole: 'electron-main',
      };
      clock.writeLine(`${JSON.stringify(marker)}\n`);
    },
  };
}

type FileSinkFs = {
  openSync: (path: string, flags: string) => number;
  writeSync: (fd: number, line: string) => number;
};

export function createFileMarkerSink(
  eventsPath: string,
  fs: FileSinkFs = { openSync, writeSync },
): Pick<MarkerClock, 'writeLine'> {
  let fileDescriptor: number | null = null;
  let writable = true;
  return {
    writeLine(line) {
      if (!writable) return;
      try {
        fileDescriptor ??= fs.openSync(eventsPath, 'a');
        fs.writeSync(fileDescriptor, line);
      } catch {
        writable = false;
      }
    },
  };
}

export function createDefaultMarkerCollector(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<MarkerClock> = {},
): MarkerCollector {
  const config = parseMarkerConfig(env);
  if (!config.enabled) {
    return createMarkerCollector(config, {
      pid: process.pid,
      now: () => performance.now(),
      writeLine: () => undefined,
      ...overrides,
    });
  }

  const sink = createFileMarkerSink(config.eventsPath);
  return createMarkerCollector(config, {
    pid: process.pid,
    now: () => performance.now(),
    writeLine: sink.writeLine,
    ...overrides,
  });
}

let globalCollector: MarkerCollector | null = null;
let globalMarkerContext: MarkerFields = {};

export function getPerformanceMarkerCollector(): MarkerCollector {
  if (!globalCollector) {
    globalCollector = createDefaultMarkerCollector();
  }
  return globalCollector;
}

export function resetPerformanceMarkerCollectorForTests(): void {
  globalCollector = null;
  globalMarkerContext = {};
}

export function setPerformanceMarkerCollector(collector: MarkerCollector): void {
  globalCollector = collector;
}

export function emitPerformanceMarker(event: string, fields?: MarkerFields): void {
  getPerformanceMarkerCollector().emit(event, { ...fields, ...globalMarkerContext });
}

export function setPerformanceMarkerContext(fields: MarkerFields = {}): void {
  globalMarkerContext = sanitizeMarkerFields(fields);
}
