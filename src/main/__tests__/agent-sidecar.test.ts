import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';
import type { AppConfig } from '../../types/ipc';
import type { SidecarEvent } from '../../agent/protocol';

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

const config: AppConfig = {
  whisperUrl: 'http://localhost:8080/inference',
  transcription: {
    activeProvider: 'local-whisper-cpp',
    providers: {
      localWhisperCpp: { endpoint: 'http://localhost:8080/inference' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
      customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
    },
  },
  selectedDeviceId: null,
  removeFillerWords: true,
  language: 'auto',
  task: 'transcribe',
  dictionary: [],
  pasteStrategy: { default: 'ctrl-v', overrides: {} },
  setupChecklistDismissed: false,
  recordingActivationMode: 'push-to-talk',
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

  it('starts the sidecar lazily and sends config plus agent start JSONL', async () => {
    const events: unknown[] = [];
    const { AgentSidecarManager } = await import(`../agent-sidecar?test=${Date.now()}-1`);
    const manager = new AgentSidecarManager((event: SidecarEvent) => events.push(event));

    const agentRunId = 'run-1';
    manager.startRun(agentRunId, 'check mail', config);

    expect(spawn).toHaveBeenCalledWith(
      'bun.exe',
      ['D:\\git_repos\\speech-2-text\\src\\agent\\index.ts'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    );
    expect(stdinWrite).toHaveBeenNthCalledWith(1, `${JSON.stringify({ type: 'config:update', config })}\n`);
    expect(JSON.parse(stdinWrite.mock.calls[1]?.[0] as string)).toEqual({
      type: 'agent:start',
      agentRunId,
      transcript: 'check mail',
    });

    stdoutLines.emit('line', JSON.stringify({ type: 'sidecar:ready', protocolVersion: 1 }));
    expect(events).toEqual([{ type: 'sidecar:ready', protocolVersion: 1 }]);
  });

  it('delivers a stored API key only in the main-to-sidecar config update', async () => {
    const { AgentSidecarManager } = await import(`../agent-sidecar?test=${Date.now()}-stored-key`);
    const manager = new AgentSidecarManager(() => undefined);

    manager.startRun('run-1', 'check mail', config, 'stored-agent-secret');

    expect(JSON.parse(stdinWrite.mock.calls[0]?.[0] as string)).toEqual({
      type: 'config:update',
      config,
      agentApiKey: 'stored-agent-secret',
    });
  });

  it('runs the packaged sidecar under Electron node mode instead of launching another app instance', async () => {
    electronMock.app.isPackaged = true;
    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: 'C:\\Program Files\\Shuddhalekhan\\resources',
    });

    try {
      const { AgentSidecarManager } = await import(`../agent-sidecar?test=${Date.now()}-packaged`);
      const manager = new AgentSidecarManager(() => undefined);

      manager.start(config);

      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        ['C:\\Program Files\\Shuddhalekhan\\resources\\app.asar\\out\\agent\\index.js'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
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
    const { AgentSidecarManager } = await import(`../agent-sidecar?test=${Date.now()}-blank`);
    const manager = new AgentSidecarManager((event: SidecarEvent) => events.push(event));

    manager.startRun('run-1', 'check mail', config);
    stdoutLines.emit('line', '');
    stdoutLines.emit('line', '   ');

    expect(events).toEqual([]);
  });

  it('uses the provided run id when starting and cancelling runs', async () => {
    const { AgentSidecarManager } = await import(`../agent-sidecar?test=${Date.now()}-2`);
    const manager = new AgentSidecarManager(() => undefined);

    manager.startRun('run-1', 'first', config);
    manager.cancelRun('run-1');

    expect(JSON.parse(stdinWrite.mock.calls[1]?.[0] as string)).toEqual({
      type: 'agent:start',
      agentRunId: 'run-1',
      transcript: 'first',
    });
    expect(JSON.parse(stdinWrite.mock.calls[2]?.[0] as string)).toEqual({
      type: 'agent:cancel',
      agentRunId: 'run-1',
    });
  });

  it('emits all parsed sidecar events regardless of run id', async () => {
    const events: unknown[] = [];
    const { AgentSidecarManager } = await import(`../agent-sidecar?test=${Date.now()}-3`);
    const manager = new AgentSidecarManager((event: SidecarEvent) => events.push(event));

    manager.startRun('current', 'current', config);
    stdoutLines.emit('line', JSON.stringify({ type: 'agent:completed', agentRunId: 'stale', response: 'old', toolSummary: [] }));
    stdoutLines.emit('line', JSON.stringify({ type: 'agent:completed', agentRunId: 'current', response: 'done', toolSummary: [] }));

    expect(events).toEqual([
      { type: 'agent:completed', agentRunId: 'stale', response: 'old', toolSummary: [] },
      { type: 'agent:completed', agentRunId: 'current', response: 'done', toolSummary: [] },
    ]);
  });

  it('stops the process without sending a run-scoped cancel', async () => {
    const { AgentSidecarManager } = await import(`../agent-sidecar?test=${Date.now()}-4`);
    const manager = new AgentSidecarManager(() => undefined);

    manager.startRun('run-1', 'cancel me', config);
    manager.stop();

    expect(stdinWrite.mock.calls).toHaveLength(2);
    expect(childKill).toHaveBeenCalled();
  });
});
