import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  createMarkerCollector,
  resetPerformanceMarkerCollectorForTests,
  setPerformanceMarkerCollector,
} from '../performance/marker-collector';

const vi = { fn: mock };
const mergeDiscoveredTools = vi.fn();
const getConfig = vi.fn(() => ({
  agent: {
    mcpServers: [
      { id: 'mail', displayName: 'Gmail' },
    ],
  },
}));

describe('SidecarEventRouter', () => {
  let send: ReturnType<typeof vi.fn>;
  let getSettingsWindow: ReturnType<typeof vi.fn>;
  let getActiveAgentRunId: ReturnType<typeof vi.fn>;
  let showAgentToast: ReturnType<typeof vi.fn>;
  let openExternal: ReturnType<typeof vi.fn>;
  let router: import('../sidecar-event-router').SidecarEventRouter;

  beforeEach(async () => {
    const { createSidecarEventRouter } = await import(`../sidecar-event-router?test=${Date.now()}-${Math.random()}`);
    send = vi.fn();
    getSettingsWindow = vi.fn(() => ({
      webContents: { send },
      isDestroyed: vi.fn(() => false),
    }));
    getActiveAgentRunId = vi.fn(() => 'run-1');
    showAgentToast = vi.fn();
    openExternal = vi.fn(async () => undefined);
    mergeDiscoveredTools.mockClear();
    router = createSidecarEventRouter({
      getSettingsWindow,
      getActiveAgentRunId,
      showAgentToast,
      openExternal,
      mergeDiscoveredTools,
      getConfig,
    });
  });

  it('forwards MCP server status to the settings window', () => {
    router.handle({
      type: 'mcp:server-status',
      serverId: 'mail',
      status: 'connected',
      message: 'ready',
    });

    expect(send).toHaveBeenCalledWith('mcp:server-status', {
      serverId: 'mail',
      status: 'connected',
      message: 'ready',
    });
  });

  it('records MCP connection request before discovery and connection completion', () => {
    const lines: string[] = [];
    setPerformanceMarkerCollector(createMarkerCollector(
      {
        enabled: true,
        runId: 'run-1',
        scenarioId: 'mcp-stdio-tool',
        eventsPath: 'events.jsonl',
      },
      { pid: 7, now: () => 10, writeLine: (line) => lines.push(line) },
    ));

    router.handle({ type: 'mcp:server-status', serverId: 'mail', status: 'connecting' });
    router.handle({ type: 'mcp:tools-discovered', serverId: 'mail', tools: [] });
    router.handle({ type: 'mcp:server-status', serverId: 'mail', status: 'connected' });

    expect(lines.map((line) => JSON.parse(line).event)).toEqual([
      'mcp.connect.requested',
      'mcp.tools.discovered',
    ]);
    resetPerformanceMarkerCollectorForTests();
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

  it('maps agent status, streaming, completion, failure, and cancellation to toasts', () => {
    router.handle({ type: 'agent:status', agentRunId: 'run-1', status: 'Checking mail' });
    router.handle({ type: 'agent:response-delta', agentRunId: 'run-1', delta: 'Done', response: 'Done' });
    router.handle({ type: 'agent:completed', agentRunId: 'run-1', response: 'Finished', toolSummary: ['Read 3 messages'] });
    router.handle({ type: 'agent:failed', agentRunId: 'run-1', error: 'Provider failed' });
    router.handle({ type: 'agent:cancelled', agentRunId: 'run-1' });

    expect(showAgentToast).toHaveBeenNthCalledWith(1, {
      kind: 'status',
      agentRunId: 'run-1',
      message: 'Checking mail',
    });
    expect(showAgentToast).toHaveBeenNthCalledWith(2, {
      kind: 'streaming',
      agentRunId: 'run-1',
      response: 'Done',
    });
    expect(showAgentToast).toHaveBeenNthCalledWith(3, {
      kind: 'completed',
      agentRunId: 'run-1',
      response: 'Finished',
      toolSummary: ['Read 3 messages'],
    });
    expect(showAgentToast).toHaveBeenNthCalledWith(4, {
      kind: 'failed',
      agentRunId: 'run-1',
      error: 'Provider failed',
    });
    expect(showAgentToast).toHaveBeenNthCalledWith(5, {
      kind: 'cancelled',
      agentRunId: 'run-1',
    });
  });

  it('records Agent terminal outcomes when no response delta arrives', () => {
    const lines: string[] = [];
    setPerformanceMarkerCollector(createMarkerCollector(
      {
        enabled: true,
        runId: 'benchmark-run',
        scenarioId: 'agent-no-mcp',
        eventsPath: 'events.jsonl',
      },
      { pid: 7, now: () => 10, writeLine: (line) => lines.push(line) },
    ));

    router.handle({ type: 'agent:completed', agentRunId: 'run-1', response: '', toolSummary: [] });
    router.handle({ type: 'agent:failed', agentRunId: 'run-1', error: 'Provider failed' });
    router.handle({ type: 'agent:cancelled', agentRunId: 'run-1' });

    expect(lines.map((line) => {
      const marker = JSON.parse(line);
      return [marker.event, marker.agentRunId];
    })).toEqual([
      ['agent.completed', 'run-1'],
      ['agent.failed', 'run-1'],
      ['agent.cancelled', 'run-1'],
    ]);
    resetPerformanceMarkerCollectorForTests();
  });

  it('records the sidecar provider-request boundary in the main-process clock', () => {
    const lines: string[] = [];
    setPerformanceMarkerCollector(createMarkerCollector(
      {
        enabled: true,
        runId: 'benchmark-run',
        scenarioId: 'agent-no-mcp',
        eventsPath: 'events.jsonl',
      },
      { pid: 7, now: () => 10, writeLine: (line) => lines.push(line) },
    ));

    router.handle({ type: 'agent:provider-request-started', agentRunId: 'run-1' });

    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      { event: 'agent.provider.request.started', agentRunId: 'run-1' },
    ]);
    resetPerformanceMarkerCollectorForTests();
  });

  it('records MCP tool execution start and result without tool payloads', () => {
    const lines: string[] = [];
    setPerformanceMarkerCollector(createMarkerCollector(
      {
        enabled: true,
        runId: 'benchmark-run',
        scenarioId: 'mcp-stdio-tool',
        eventsPath: 'events.jsonl',
      },
      { pid: 7, now: () => 10, writeLine: (line) => lines.push(line) },
    ));

    router.handle({
      type: 'mcp:tool-execute-started',
      agentRunId: 'run-1',
      serverId: 'mail',
      toolName: 'echo',
    });
    router.handle({
      type: 'mcp:tool-execute-result',
      agentRunId: 'run-1',
      serverId: 'mail',
      toolName: 'echo',
      outcome: 'success',
    });

    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      { event: 'mcp.tool.execute.started', agentRunId: 'run-1', serverId: 'mail' },
      { event: 'mcp.tool.execute.result', agentRunId: 'run-1', serverId: 'mail', outcome: 'success' },
    ]);
    resetPerformanceMarkerCollectorForTests();
  });

  it('shows both waiting status and approval details when approval is requested', () => {
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

    expect(showAgentToast).toHaveBeenNthCalledWith(1, {
      kind: 'status',
      agentRunId: 'run-1',
      message: 'Waiting for approval: mail.send_email',
    });
    expect(showAgentToast).toHaveBeenNthCalledWith(2, {
      kind: 'approval',
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      serverId: 'mail',
      serverDisplayName: 'Gmail',
      toolName: 'send_email',
      modelToolName: 'mail__send_email',
      arguments: { to: 'a@example.com' },
      expiresAt: '2026-05-11T12:00:00.000Z',
    });
  });
});
