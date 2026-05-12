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
  selectedDeviceId: null,
  removeFillerWords: true,
  language: '',
  task: 'transcribe',
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

    const agentRunId = manager.startRun('check mail', config);

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

    manager.startRun('check mail', config);
    stdoutLines.emit('line', '');
    stdoutLines.emit('line', '   ');

    expect(events).toEqual([]);
  });

  it('cancels the active run before starting the next run', async () => {
    const { AgentSidecarManager } = await import(`../agent-sidecar?test=${Date.now()}-2`);
    const manager = new AgentSidecarManager(() => undefined);

    const firstRunId = manager.startRun('first', config);
    const secondRunId = manager.startRun('second', config);

    expect(JSON.parse(stdinWrite.mock.calls[2]?.[0] as string)).toEqual({
      type: 'agent:cancel',
      agentRunId: firstRunId,
    });
    expect(JSON.parse(stdinWrite.mock.calls[3]?.[0] as string)).toEqual({
      type: 'config:update',
      config,
    });
    expect(JSON.parse(stdinWrite.mock.calls[4]?.[0] as string)).toEqual({
      type: 'agent:start',
      agentRunId: secondRunId,
      transcript: 'second',
    });
  });

  it('ignores stale run-scoped sidecar events', async () => {
    const events: unknown[] = [];
    const { AgentSidecarManager } = await import(`../agent-sidecar?test=${Date.now()}-3`);
    const manager = new AgentSidecarManager((event: SidecarEvent) => events.push(event));

    const agentRunId = manager.startRun('current', config);
    stdoutLines.emit('line', JSON.stringify({ type: 'agent:completed', agentRunId: 'stale', response: 'old' }));
    stdoutLines.emit('line', JSON.stringify({
      type: 'agent:completed',
      agentRunId,
      response: 'done',
      toolSummary: [],
    }));

    expect(events).toEqual([
      {
        type: 'agent:completed',
        agentRunId,
        response: 'done',
        toolSummary: [],
      },
    ]);
    expect(manager.getActiveAgentRunId()).toBeNull();
  });

  it('stops the process and clears active run state', async () => {
    const { AgentSidecarManager } = await import(`../agent-sidecar?test=${Date.now()}-4`);
    const manager = new AgentSidecarManager(() => undefined);

    const agentRunId = manager.startRun('cancel me', config);
    manager.stop();

    expect(JSON.parse(stdinWrite.mock.calls[2]?.[0] as string)).toEqual({
      type: 'agent:cancel',
      agentRunId,
    });
    expect(childKill).toHaveBeenCalled();
    expect(manager.getActiveAgentRunId()).toBeNull();
  });
});
