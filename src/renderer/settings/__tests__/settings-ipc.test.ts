import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AppConfig, McpServerRuntimeStatus, UpdateStatus } from '../../../types/ipc';
import { createSettingsIpc } from '../settings-ipc';

const vi = { fn: mock };

const config: AppConfig = {
  whisperUrl: 'http://localhost:8080/inference',
  selectedDeviceId: null,
  removeFillerWords: true,
  language: 'auto',
  task: 'transcribe',
  dictionary: [],
  pasteStrategy: { default: 'ctrl-v', overrides: {} },
  setupChecklistDismissed: false,
  agent: {
    enabled: false,
    provider: {
      baseUrl: '',
      model: '',
      apiKeyEnvVar: '',
      thinkingEnabled: true,
    },
    mcpServers: [],
  },
};

const updateStatus: UpdateStatus = {
  state: 'idle',
  currentVersion: '4.0.0',
  message: 'Shuddhalekhan v4.0.0',
  checkedAt: null,
};

describe('settings IPC adapter', () => {
  let invoke: ReturnType<typeof vi.fn>;
  let on: ReturnType<typeof vi.fn>;
  let ipc: ReturnType<typeof createSettingsIpc>;

  beforeEach(() => {
    invoke = vi.fn((channel: string) => {
      if (channel === 'config:get') return Promise.resolve(config);
      if (channel === 'app:get-info') return Promise.resolve({ name: 'Shuddhalekhan', version: '4.0.0', isPackaged: false });
      if (channel === 'updater:get-status') return Promise.resolve(updateStatus);
      if (channel === 'updater:check') return Promise.resolve(updateStatus);
      return Promise.resolve(undefined);
    });
    on = vi.fn(() => vi.fn());
    ipc = createSettingsIpc({ invoke, on } as never);
  });

  it('loads initial settings data through named methods', async () => {
    await expect(ipc.getConfig()).resolves.toBe(config);
    await expect(ipc.getAppInfo()).resolves.toEqual({ name: 'Shuddhalekhan', version: '4.0.0', isPackaged: false });
    await expect(ipc.getUpdateStatus()).resolves.toBe(updateStatus);

    expect(invoke).toHaveBeenNthCalledWith(1, 'config:get');
    expect(invoke).toHaveBeenNthCalledWith(2, 'app:get-info');
    expect(invoke).toHaveBeenNthCalledWith(3, 'updater:get-status');
  });

  it('saves config and forwards actions without exposing channel names to callers', async () => {
    await ipc.setConfig('agent', config.agent);
    await ipc.testMcpServer('mail');
    await ipc.checkForUpdates();

    expect(invoke).toHaveBeenCalledWith('config:set', 'agent', config.agent);
    expect(invoke).toHaveBeenCalledWith('mcp:test-server', 'mail');
    expect(invoke).toHaveBeenCalledWith('updater:check');
  });

  it('subscribes to updater and MCP status events', () => {
    const onUpdate = vi.fn();
    const onMcpStatus = vi.fn();
    const offUpdate = vi.fn();
    const offMcp = vi.fn();
    on.mockReturnValueOnce(offUpdate).mockReturnValueOnce(offMcp);

    expect(ipc.onUpdateStatusChanged(onUpdate)).toBe(offUpdate);
    expect(ipc.onMcpServerStatus(onMcpStatus)).toBe(offMcp);

    const status: McpServerRuntimeStatus = { serverId: 'mail', status: 'connected' };
    const updateCallback = on.mock.calls[0]?.[1] as (nextStatus: UpdateStatus) => void;
    const mcpCallback = on.mock.calls[1]?.[1] as (nextStatus: McpServerRuntimeStatus) => void;
    updateCallback(updateStatus);
    mcpCallback(status);

    expect(on).toHaveBeenNthCalledWith(1, 'updater:status-changed', expect.any(Function));
    expect(on).toHaveBeenNthCalledWith(2, 'mcp:server-status', expect.any(Function));
    expect(onUpdate).toHaveBeenCalledWith(updateStatus);
    expect(onMcpStatus).toHaveBeenCalledWith(status);
  });

  it('handles audit log queries and updates', async () => {
    const mockRuns = [{ agentRunId: 'run-1', startedAt: '2026-05-20T12:00:00Z', transcript: 'test prompt', status: 'completed' as const, tools: [] }];
    const mockEvents = [{ id: 1, agentRunId: 'run-1', eventType: 'run_started', payload: {}, createdAt: '2026-05-20T12:00:00Z' }];
    invoke.mockImplementation((channel: string, ...args: any[]) => {
      if (channel === 'audit:get-runs') return Promise.resolve(mockRuns);
      if (channel === 'audit:get-run-detail' && args[0] === 'run-1') return Promise.resolve(mockEvents);
      return Promise.resolve(undefined);
    });

    await expect(ipc.getAuditRuns()).resolves.toEqual(mockRuns);
    await expect(ipc.getAuditRunDetail('run-1')).resolves.toEqual(mockEvents);
    expect(invoke).toHaveBeenCalledWith('audit:get-runs');
    expect(invoke).toHaveBeenCalledWith('audit:get-run-detail', 'run-1');

    const onAuditUpdated = vi.fn();
    const offAudit = vi.fn();
    on.mockReturnValueOnce(offAudit);

    expect(ipc.onAuditRunUpdated(onAuditUpdated)).toBe(offAudit);
    expect(on).toHaveBeenLastCalledWith('audit:run-updated', expect.any(Function));

    const auditCallback = on.mock.calls[on.mock.calls.length - 1]?.[1] as (runId: string) => void;
    auditCallback('run-1');
    expect(onAuditUpdated).toHaveBeenCalledWith('run-1');
  });
});
