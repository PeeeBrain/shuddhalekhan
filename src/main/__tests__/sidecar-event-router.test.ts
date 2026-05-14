import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AppConfig } from '../../types/ipc';
import { createSidecarEventRouter } from '../sidecar-event-router';

const vi = { fn: mock };

const baseConfig: AppConfig = {
  whisperUrl: 'http://localhost:8080/inference',
  selectedDeviceId: null,
  removeFillerWords: true,
  language: 'auto',
  task: 'transcribe',
  agent: {
    enabled: true,
    provider: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4.1-mini',
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      thinkingEnabled: true,
    },
    mcpServers: [
      {
        id: 'mail',
        displayName: 'Hosted Mail',
        enabled: true,
        transport: { type: 'http', url: 'https://mail.example.com/mcp' },
        discoveredTools: [],
        toolPolicies: {},
      },
    ],
  },
};

describe('SidecarEventRouter', () => {
  let send: ReturnType<typeof vi.fn>;
  let getSettingsWindow: ReturnType<typeof vi.fn>;
  let getConfig: ReturnType<typeof vi.fn>;
  let setConfig: ReturnType<typeof vi.fn>;
  let showAgentToast: ReturnType<typeof vi.fn>;
  let openExternal: ReturnType<typeof vi.fn>;
  let router: ReturnType<typeof createSidecarEventRouter>;

  beforeEach(() => {
    send = vi.fn();
    getSettingsWindow = vi.fn(() => ({
      webContents: { send },
      isDestroyed: vi.fn(() => false),
    }));
    getConfig = vi.fn(() => baseConfig);
    setConfig = vi.fn();
    showAgentToast = vi.fn();
    openExternal = vi.fn(async () => undefined);
    router = createSidecarEventRouter({
      getSettingsWindow,
      getConfig,
      setConfig,
      showAgentToast,
      openExternal,
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

  it('opens OAuth authorization URLs externally', () => {
    router.handle({
      type: 'oauth:open-url',
      serverId: 'mail',
      url: 'https://perfect-horizon.example.com/oauth/authorize',
    });

    expect(openExternal).toHaveBeenCalledWith('https://perfect-horizon.example.com/oauth/authorize');
  });

  it('persists discovered tools and defaults new tool policies to alwaysAsk', () => {
    router.handle({
      type: 'mcp:tools-discovered',
      serverId: 'mail',
      tools: [
        { name: 'read_email', description: 'Read messages', inputSchema: { type: 'object' } },
        { name: 'send_email', description: 'Send messages' },
      ],
    });

    expect(setConfig).toHaveBeenCalledWith('agent', {
      ...baseConfig.agent,
      mcpServers: [
        expect.objectContaining({
          id: 'mail',
          discoveredTools: [
            expect.objectContaining({
              name: 'read_email',
              description: 'Read messages',
              inputSchema: { type: 'object' },
              discoveredAt: expect.any(String),
            }),
            expect.objectContaining({
              name: 'send_email',
              description: 'Send messages',
              discoveredAt: expect.any(String),
            }),
          ],
          toolPolicies: {
            'mail:read_email': 'alwaysAsk',
            'mail:send_email': 'alwaysAsk',
          },
        }),
      ],
    });
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
      toolName: 'send_email',
      modelToolName: 'mail__send_email',
      arguments: { to: 'a@example.com' },
      expiresAt: '2026-05-11T12:00:00.000Z',
    });
  });
});
