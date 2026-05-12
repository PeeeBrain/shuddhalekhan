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
    await ipc.testMcpServer('gmail');
    await ipc.checkForUpdates();

    expect(invoke).toHaveBeenCalledWith('config:set', 'agent', config.agent);
    expect(invoke).toHaveBeenCalledWith('mcp:test-server', 'gmail');
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

    const status: McpServerRuntimeStatus = { serverId: 'gmail', status: 'connected' };
    const updateCallback = on.mock.calls[0]?.[1] as (nextStatus: UpdateStatus) => void;
    const mcpCallback = on.mock.calls[1]?.[1] as (nextStatus: McpServerRuntimeStatus) => void;
    updateCallback(updateStatus);
    mcpCallback(status);

    expect(on).toHaveBeenNthCalledWith(1, 'updater:status-changed', expect.any(Function));
    expect(on).toHaveBeenNthCalledWith(2, 'mcp:server-status', expect.any(Function));
    expect(onUpdate).toHaveBeenCalledWith(updateStatus);
    expect(onMcpStatus).toHaveBeenCalledWith(status);
  });
});
