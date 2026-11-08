import { beforeEach, describe, expect, it, mock } from 'bun:test';

const vi = { fn: mock };
const mergeDiscoveredTools = vi.fn();
const getConfig = vi.fn(() => ({
  agent: {
    mcpServers: [
      { id: 'mail', displayName: 'Gmail' },
    ],
  },
}));

const harness = {
  presenter: {
    beginRun: vi.fn(),
    status: vi.fn(),
    streaming: vi.fn(),
    approval: vi.fn(),
    completed: vi.fn(),
    failed: vi.fn(),
    cancelled: vi.fn(),
  },
};

describe('SidecarEventRouter', () => {
  let send: ReturnType<typeof vi.fn>;
  let getSettingsWindow: ReturnType<typeof vi.fn>;
  let getActiveAgentRunId: ReturnType<typeof vi.fn>;
  let openExternal: ReturnType<typeof vi.fn>;
  let recordMcpStatus: ReturnType<typeof vi.fn>;
  let router: import('../sidecar-event-router').SidecarEventRouter;

  beforeEach(async () => {
    const { createSidecarEventRouter } = await import(`../sidecar-event-router?test=${Date.now()}-${Math.random()}`);
    send = vi.fn();
    getSettingsWindow = vi.fn(() => ({
      webContents: { send },
      isDestroyed: vi.fn(() => false),
    }));
    getActiveAgentRunId = vi.fn(() => 'run-1');
    openExternal = vi.fn(async () => undefined);
    recordMcpStatus = vi.fn(() => ({
      revision: 7,
      servers: [{ serverId: 'mail', status: 'connected', message: 'ready' }],
    }));
    mergeDiscoveredTools.mockClear();
    for (const fn of Object.values(harness.presenter)) fn.mockClear();
    router = createSidecarEventRouter({
      getSettingsWindow,
      getActiveAgentRunId,
      presenter: harness.presenter,
      openExternal,
      mergeDiscoveredTools,
      getConfig,
      recordMcpStatus,
    });
  });

  it('forwards MCP server status to the settings window', () => {
    router.handle({
      type: 'mcp:server-status',
      serverId: 'mail',
      status: 'connected',
      message: 'ready',
    });

    expect(recordMcpStatus).toHaveBeenCalledWith({
      serverId: 'mail',
      status: 'connected',
      message: 'ready',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('mcp:status-snapshot', {
      revision: 7,
      servers: [{ serverId: 'mail', status: 'connected', message: 'ready' }],
    });
  });

  it('opens OAuth authorization URLs externally', () => {
    router.handle({
      type: 'oauth:open-url',
      serverId: 'mail',
      url: 'https://perfect-horizon.example.com/oauth/authorize',
    });

    expect(openExternal).toHaveBeenCalledWith('https://perfect-horizon.example.com/oauth/authorize');
  });

  it('dispatches discovered tools to the config module', () => {
    const tools = [
      { name: 'read_email', description: 'Read messages', inputSchema: { type: 'object' } },
      { name: 'send_email', description: 'Send messages' },
    ];

    router.handle({
      type: 'mcp:tools-discovered',
      serverId: 'mail',
      tools,
    });

    expect(mergeDiscoveredTools).toHaveBeenCalledWith('mail', tools);
  });

  it('maps agent status, streaming, completion, failure, and cancellation onto the presenter', () => {
    router.handle({ type: 'agent:status', agentRunId: 'run-1', status: 'Checking mail' });
    router.handle({ type: 'agent:response-delta', agentRunId: 'run-1', delta: 'Done', response: 'Done' });
    router.handle({ type: 'agent:completed', agentRunId: 'run-1', response: 'Finished', toolSummary: ['Read 3 messages'] });
    router.handle({ type: 'agent:failed', agentRunId: 'run-1', error: 'Provider failed' });
    router.handle({ type: 'agent:cancelled', agentRunId: 'run-1' });

    expect(harness.presenter.status).toHaveBeenCalledWith('run-1', 'Checking mail');
    expect(harness.presenter.streaming).toHaveBeenCalledWith('run-1', 'Done');
    expect(harness.presenter.completed).toHaveBeenCalledWith('run-1', 'Finished', ['Read 3 messages']);
    expect(harness.presenter.failed).toHaveBeenCalledWith('run-1', 'Provider failed');
    expect(harness.presenter.cancelled).toHaveBeenCalledWith('run-1');
  });

  it('presents one approval card per request without redundant waiting status', () => {
    router.handle({
      type: 'approval:requested',
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      serverId: 'mail',
      toolName: 'send_email',
      modelToolName: 'mail__send_email',
      arguments: { to: 'a@example.com' },
      expiresAt: '2026-05-11T12:00:00.000Z',
    });

    // The waiting indicator belongs to the presentation layer, not the router:
    // the shared shell shows the approval itself, while the legacy presenter
    // synthesizes its own preceding status toast.
    expect(harness.presenter.approval).toHaveBeenCalledTimes(1);
    expect(harness.presenter.approval).toHaveBeenCalledWith({
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      serverId: 'mail',
      serverDisplayName: 'Gmail',
      toolName: 'send_email',
      modelToolName: 'mail__send_email',
      arguments: { to: 'a@example.com' },
      expiresAt: '2026-05-11T12:00:00.000Z',
    });
    expect(harness.presenter.status).not.toHaveBeenCalled();
  });

  it('drops stale run events before they reach the presenter', () => {
    getActiveAgentRunId.mockReturnValue('run-current');

    router.handle({ type: 'agent:status', agentRunId: 'run-stale', status: 'Late news' });
    router.handle({ type: 'agent:response-delta', agentRunId: 'run-stale', delta: 'x', response: 'x' });
    router.handle({ type: 'approval:requested', agentRunId: 'run-stale', approvalId: 'a', serverId: 's', toolName: 't', modelToolName: 's__t', arguments: {}, expiresAt: '2026-05-11T12:00:00.000Z' });

    expect(harness.presenter.status).not.toHaveBeenCalled();
    expect(harness.presenter.streaming).not.toHaveBeenCalled();
    expect(harness.presenter.approval).not.toHaveBeenCalled();
  });
});
