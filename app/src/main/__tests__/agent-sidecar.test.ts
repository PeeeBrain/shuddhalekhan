import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';
import type { AppConfig } from '../../types/ipc';
import type { SidecarEvent } from '../../agent/protocol';
import {
  createMarkerCollector,
  resetPerformanceMarkerCollectorForTests,
  setPerformanceMarkerCollector,
} from '../performance/marker-collector';

const vi = { fn: mock, mock: mock.module };

const stdinWrite = vi.fn();
const childKill = vi.fn();
const stdout = new EventEmitter();
const stderr = new EventEmitter();
const child = Object.assign(new EventEmitter(), {
  stdin: { write: stdinWrite },
  stdout,
  stderr,
  killed: false,
  kill: childKill,
  pid: 4321,
});
const spawn = vi.fn(() => child);

class MockInterface extends EventEmitter {
  close = vi.fn();
}

const stdoutLines = new MockInterface();
const createInterface = vi.fn(() => stdoutLines);

mock.module('child_process', () => ({ spawn }));
mock.module('readline', () => ({ createInterface }));
installElectronMock();

class FakeJobPort {
  created: unknown[] = [];
  assigned: Array<[unknown, number]> = [];
  terminated: unknown[] = [];
  failCreate = false;
  failAssign = false;
  throwCreate = false;
  throwAssign = false;

  createKillOnCloseJob(): unknown | null {
    if (this.throwCreate) throw new TypeError('native create failed');
    if (this.failCreate) return null;
    const handle = { id: `job-${this.created.length + 1}` };
    this.created.push(handle);
    return handle;
  }

  assign(job: unknown, pid: number): boolean {
    if (this.throwAssign) throw new TypeError('native assign failed');
    this.assigned.push([job, pid]);
    return !this.failAssign;
  }

  terminate(job: unknown): void {
    this.terminated.push(job);
  }
}

type ScheduledTimeout = { fn: () => void; cancelled: boolean };

function createManualScheduler() {
  const scheduled: ScheduledTimeout[] = [];
  const scheduleTimeout = (fn: () => void, _ms: number) => {
    const entry: ScheduledTimeout = { fn, cancelled: false };
    scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const runDue = () => {
    for (const entry of scheduled.splice(0)) {
      if (!entry.cancelled) entry.fn();
    }
  };
  return { scheduled, scheduleTimeout, runDue };
}

async function importManager(testName: string): Promise<typeof import('../agent-sidecar')> {
  return import(`../agent-sidecar?test=${Date.now()}-${testName}`);
}

function sentMessages(): Array<{ type: string; [key: string]: unknown }> {
  return stdinWrite.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
}

const config: AppConfig = {
  whisperUrl: 'http://localhost:8080/inference',
  transcription: {
    activeProvider: 'local-whisper-cpp',
    providers: {
      localWhisperCpp: { endpoint: 'http://localhost:8080/inference' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
      azureSpeech: { endpoint: '', region: '' },
      googleCloudSpeech: { project: '', location: 'global', model: '', credentialSource: 'service-account' },
      nvidiaSpeechNim: { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
      customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
      whisperLiveKit: { baseUrl: 'http://localhost:8000', auth: 'none' },
    },
  },
  selectedDeviceId: null,
  removeFillerWords: true,
  language: 'auto',
  task: 'transcribe',
  dictionary: [],
  pasteStrategy: { default: 'ctrl-v', overrides: {} },
  setupChecklistDismissed: false,
  shortcuts: {
    dictation: { binding: { keyCode: null, modifiers: ['ctrl', 'win'] }, activationMode: 'push-to-talk' },
    agent: { binding: { keyCode: null, modifiers: ['alt', 'win'] }, activationMode: 'push-to-talk' },
  },
  dictation: { mode: 'batch', formatter: null },
  agent: {
    enabled: true,
    provider: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4.1-mini',
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      thinkingEnabled: true,
    },
    mcpServers: [],
  },
};

describe('AgentSidecarManager', () => {
  beforeEach(() => {
    resetElectronMock();
    electronMock.app.getAppPath.mockReturnValue('D:\\git_repos\\speech-2-text');
    electronMock.app.getPath.mockImplementation((name: string) =>
      name === 'appData' ? 'C:\\Users\\tester\\AppData\\Roaming' : 'C:\\Users\\tester\\AppData\\Roaming\\@shuddhalekhan\\app'
    );
    stdinWrite.mockClear();
    childKill.mockClear();
    spawn.mockClear();
    createInterface.mockClear();
    stdoutLines.removeAllListeners();
    child.removeAllListeners();
    stdout.removeAllListeners();
    stderr.removeAllListeners();
    child.killed = false;
  });

  it('queues config and run start until the sidecar is ready, then publishes in order', async () => {
    const events: unknown[] = [];
    const { AgentSidecarManager } = await importManager('queue-until-ready');
    const manager = new AgentSidecarManager((event: SidecarEvent) => events.push(event), {
      jobPort: new FakeJobPort(),
    });

    manager.startRun('run-1', 'check mail', config);

    expect(spawn).toHaveBeenCalledWith(
      'bun.exe',
      ['D:\\git_repos\\speech-2-text\\src\\agent\\index.ts'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    );
    expect(sentMessages()).toEqual([]);

    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));

    expect(sentMessages()).toEqual([
      { type: 'config:update', config },
      { type: 'agent:start', agentRunId: 'run-1', transcript: 'check mail' },
    ]);
    expect(events).toEqual([{ type: 'sidecar:ready', protocolVersion: 1 }]);
  });

  it('assigns the sidecar to a kill-on-close job before publishing configuration', async () => {
    const jobPort = new FakeJobPort();
    const { AgentSidecarManager } = await importManager('assign-before-config');
    const manager = new AgentSidecarManager(() => undefined, { jobPort });

    manager.start(config);
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));

    expect(jobPort.created).toHaveLength(1);
    expect(jobPort.assigned).toEqual([[jobPort.created[0], 4321]]);
    expect(sentMessages()).toEqual([{ type: 'config:update', config }]);
  });

  it('fails closed without spawning when the job object cannot be created', async () => {
    const lifecycleErrors: unknown[] = [];
    const jobPort = new FakeJobPort();
    jobPort.failCreate = true;
    const { AgentSidecarManager } = await importManager('fail-create');
    const manager = new AgentSidecarManager(() => undefined, {
      jobPort,
      onLifecycleError: (error) => lifecycleErrors.push(error),
    });

    manager.startRun('run-1', 'check mail', config);

    expect(spawn).not.toHaveBeenCalled();
    expect(sentMessages()).toEqual([]);
    expect(lifecycleErrors).toEqual([{ reason: 'job-creation-failed' }]);
  });

  it('turns a native job creation exception into a fail-closed lifecycle error', async () => {
    const jobPort = new FakeJobPort();
    jobPort.throwCreate = true;
    const lifecycleErrors: unknown[] = [];
    const { AgentSidecarManager } = await importManager('throw-create');
    const manager = new AgentSidecarManager(() => undefined, {
      jobPort,
      onLifecycleError: (error) => lifecycleErrors.push(error),
    });

    expect(() => manager.start(config)).not.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    expect(lifecycleErrors).toEqual([{ reason: 'job-creation-failed' }]);
  });

  it('fails closed and kills the child when job assignment fails after spawn', async () => {
    const lifecycleErrors: unknown[] = [];
    const jobPort = new FakeJobPort();
    jobPort.failAssign = true;
    const { AgentSidecarManager } = await importManager('fail-assign');
    const manager = new AgentSidecarManager(() => undefined, {
      jobPort,
      onLifecycleError: (error) => lifecycleErrors.push(error),
    });

    manager.start(config);

    expect(jobPort.assigned).toEqual([[jobPort.created[0], 4321]]);
    expect(childKill).toHaveBeenCalled();
    expect(sentMessages()).toEqual([]);

    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));
    expect(sentMessages()).toEqual([]);
    expect(lifecycleErrors).toEqual([{ reason: 'job-assignment-failed', pid: 4321 }]);
  });

  it('turns a native job assignment exception into fail-closed teardown', async () => {
    const jobPort = new FakeJobPort();
    jobPort.throwAssign = true;
    const lifecycleErrors: unknown[] = [];
    const { AgentSidecarManager } = await importManager('throw-assign');
    const manager = new AgentSidecarManager(() => undefined, {
      jobPort,
      onLifecycleError: (error) => lifecycleErrors.push(error),
    });

    expect(() => manager.start(config)).not.toThrow();
    expect(childKill).toHaveBeenCalled();
    expect(jobPort.terminated).toEqual(jobPort.created);
    expect(lifecycleErrors).toEqual([{ reason: 'job-assignment-failed', pid: 4321 }]);
  });

  it('delivers a stored API key only in the main-to-sidecar config update', async () => {
    const { AgentSidecarManager } = await importManager('stored-key');
    const manager = new AgentSidecarManager(() => undefined, { jobPort: new FakeJobPort() });

    manager.startRun('run-1', 'check mail', config, 'stored-agent-secret');
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));

    expect(sentMessages()[0]).toEqual({
      type: 'config:update',
      config,
      agentApiKey: 'stored-agent-secret',
    });
  });

  it('marks configuration only after the config update has been sent to the sidecar', async () => {
    const lines: string[] = [];
    setPerformanceMarkerCollector(createMarkerCollector(
      { enabled: true, runId: 'run-1', scenarioId: 'agent-no-mcp', eventsPath: 'events.jsonl' },
      { pid: 7, now: () => 10, writeLine: (line) => lines.push(line) },
    ));
    const { AgentSidecarManager } = await importManager('config-marker');
    const manager = new AgentSidecarManager(() => undefined, { jobPort: new FakeJobPort() });

    manager.start(config);
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));

    expect(lines.map((line) => JSON.parse(line).event)).toContain('sidecar.config.sent');
    expect(stdinWrite).toHaveBeenCalled();
    resetPerformanceMarkerCollectorForTests();
  });

  it('runs the packaged sidecar under Electron node mode instead of launching another app instance', async () => {
    electronMock.app.isPackaged = true;
    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: 'C:\\Program Files\\Shuddhalekhan\\resources',
    });

    try {
      const { AgentSidecarManager } = await importManager('packaged');
      const manager = new AgentSidecarManager(() => undefined, { jobPort: new FakeJobPort() });

      manager.start(config);

      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        ['C:\\Program Files\\Shuddhalekhan\\resources\\app.asar\\out\\agent\\index.js'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: expect.objectContaining({
            ELECTRON_RUN_AS_NODE: '1',
            SHUDDHALEKHAN_AUDIT_DIR: 'C:\\Users\\tester\\AppData\\Roaming\\Shuddhalekhan',
          }),
        })
      );
    } finally {
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value: originalResourcesPath,
      });
    }
  });

  it('ignores blank stdout lines from the sidecar', async () => {
    const events: unknown[] = [];
    const { AgentSidecarManager } = await importManager('blank');
    const manager = new AgentSidecarManager((event: SidecarEvent) => events.push(event), {
      jobPort: new FakeJobPort(),
    });

    manager.startRun('run-1', 'check mail', config);
    stdoutLines.emit('line', '');
    stdoutLines.emit('line', '   ');

    expect(events).toEqual([]);
  });

  it('uses the provided run id when starting and cancelling runs', async () => {
    const { AgentSidecarManager } = await importManager('run-id');
    const manager = new AgentSidecarManager(() => undefined, { jobPort: new FakeJobPort() });

    manager.startRun('run-1', 'first', config);
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));
    manager.cancelRun('run-1');

    expect(sentMessages()).toEqual([
      { type: 'config:update', config },
      { type: 'agent:start', agentRunId: 'run-1', transcript: 'first' },
      { type: 'agent:cancel', agentRunId: 'run-1' },
    ]);
  });

  it('emits all parsed sidecar events regardless of run id', async () => {
    const events: unknown[] = [];
    const { AgentSidecarManager } = await importManager('all-events');
    const manager = new AgentSidecarManager((event: SidecarEvent) => events.push(event), {
      jobPort: new FakeJobPort(),
    });

    manager.startRun('current', 'current', config);
    stdoutLines.emit('line', JSON.stringify({ type: 'agent:completed', agentRunId: 'stale', response: 'old', toolSummary: [] }));
    stdoutLines.emit('line', JSON.stringify({ type: 'agent:completed', agentRunId: 'current', response: 'done', toolSummary: [] }));

    expect(events).toEqual([
      { type: 'agent:completed', agentRunId: 'stale', response: 'old', toolSummary: [] },
      { type: 'agent:completed', agentRunId: 'current', response: 'done', toolSummary: [] },
    ]);
  });

  it('stops gracefully: requests shutdown, waits for acknowledgement, then enforces teardown', async () => {
    const jobPort = new FakeJobPort();
    const { AgentSidecarManager } = await importManager('graceful-stop');
    const manager = new AgentSidecarManager(() => undefined, { jobPort });

    manager.startRun('run-1', 'check mail', config);
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));

    const stopped = manager.stop();
    expect(sentMessages().at(-1)).toEqual({ type: 'sidecar:shutdown' });
    expect(jobPort.terminated).toHaveLength(0);

    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:shutdown-complete' }));
    await stopped;

    expect(jobPort.terminated).toEqual([jobPort.created[0]]);
    expect(childKill).toHaveBeenCalled();
  });

  it('requests shutdown when readiness arrives after stop has begun', async () => {
    const { AgentSidecarManager } = await importManager('stop-before-ready');
    const manager = new AgentSidecarManager(() => undefined, { jobPort: new FakeJobPort() });

    manager.start(config);
    const stopped = manager.stop();
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));

    expect(sentMessages()).toEqual([{ type: 'sidecar:shutdown' }]);
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:shutdown-complete' }));
    await stopped;
  });

  it('replaces a gracefully-stopping generation when start is called again', async () => {
    const scheduler = createManualScheduler();
    const jobPort = new FakeJobPort();
    const { AgentSidecarManager } = await importManager('start-during-stop');
    const manager = new AgentSidecarManager(() => undefined, {
      jobPort,
      shutdownTimeoutMs: 5000,
      scheduleTimeout: scheduler.scheduleTimeout,
    });

    manager.start(config);
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));
    expect(sentMessages().map((message) => message.type)).toEqual(['config:update']);

    const stopped = manager.stop();
    expect(sentMessages().at(-1)).toMatchObject({ type: 'sidecar:shutdown' });

    // The user re-enables Agent Mode while the graceful stop is in flight:
    // the old generation must be torn down and a usable one started.
    stdinWrite.mockClear();
    child.killed = false; // Resuscitate the shared fake child for generation two.
    manager.start(config);

    expect(spawn).toHaveBeenCalledTimes(2);
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));
    expect(sentMessages().map((message) => message.type)).toEqual(['config:update']);

    child.emit('exit', 0, null);
    scheduler.runDue();
    await stopped;

    expect(jobPort.terminated).toEqual(jobPort.created);
  });

  it('enforces teardown after the bounded shutdown timeout when no acknowledgement arrives', async () => {
    const scheduler = createManualScheduler();
    const jobPort = new FakeJobPort();
    const { AgentSidecarManager } = await importManager('stop-timeout');
    const manager = new AgentSidecarManager(() => undefined, {
      jobPort,
      shutdownTimeoutMs: 5000,
      scheduleTimeout: scheduler.scheduleTimeout,
    });

    manager.startRun('run-1', 'check mail', config);
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));

    const stopped = manager.stop();
    expect(jobPort.terminated).toHaveLength(0);

    scheduler.runDue();
    await stopped;

    expect(jobPort.terminated).toEqual([jobPort.created[0]]);
  });

  it('terminates the generation job when the sidecar exits and spawns a fresh generation next start', async () => {
    const jobPort = new FakeJobPort();
    const onGenerationExit = mock();
    const { AgentSidecarManager } = await importManager('crash-cleanup');
    const manager = new AgentSidecarManager(() => undefined, { jobPort, onGenerationExit });

    manager.start(config);
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));

    child.emit('exit', 1, null);
    expect(jobPort.terminated).toEqual([jobPort.created[0]]);
    expect(onGenerationExit).toHaveBeenCalledTimes(1);

    manager.start(config);
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(jobPort.created).toHaveLength(2);
    expect(sentMessages()).toEqual([
      { type: 'config:update', config },
      { type: 'config:update', config },
    ]);
  });

  it('stops without sending a run-scoped cancel', async () => {
    const jobPort = new FakeJobPort();
    const { AgentSidecarManager } = await importManager('stop-no-cancel');
    const manager = new AgentSidecarManager(() => undefined, { jobPort });

    manager.startRun('run-1', 'cancel me', config);
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));

    const stopped = manager.stop();
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:shutdown-complete' }));
    await stopped;

    const messages = sentMessages();
    expect(messages.at(-1)).toEqual({ type: 'sidecar:shutdown' });
    expect(messages.some((message) => (message as { type: string }).type === 'agent:cancel')).toBe(false);
  });

  it('shares one graceful shutdown across concurrent stop calls', async () => {
    const jobPort = new FakeJobPort();
    const { AgentSidecarManager } = await importManager('concurrent-stop');
    const manager = new AgentSidecarManager(() => undefined, { jobPort });

    manager.start(config);
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));

    const firstStop = manager.stop();
    const secondStop = manager.stop();
    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:shutdown-complete' }));
    await Promise.all([firstStop, secondStop]);

    expect(sentMessages().filter((message) => message.type === 'sidecar:shutdown')).toHaveLength(1);
    expect(jobPort.terminated).toHaveLength(1);
  });
});
