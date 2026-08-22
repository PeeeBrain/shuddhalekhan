import { beforeEach, describe, expect, it, mock } from 'bun:test';

const vi = { fn: mock };

describe('Agent presenters', () => {
  beforeEach(() => {
    resetMocks();
  });

  function resetMocks() {
    shell.beginAgentRun.mockClear();
    shell.clearAgentRun.mockClear();
    shell.showAgentStatus.mockClear();
    shell.showAgentStreaming.mockClear();
    shell.showAgentApproval.mockClear();
    shell.showAgentCompleted.mockClear();
    shell.showAgentFailed.mockClear();
    showToast.mockClear();
    hideToast.mockClear();
  }

  const shell = {
    beginAgentRun: vi.fn(),
    clearAgentRun: vi.fn(),
    showAgentStatus: vi.fn(),
    showAgentStreaming: vi.fn(),
    showAgentApproval: vi.fn(),
    showAgentCompleted: vi.fn(),
    showAgentFailed: vi.fn(),
  };
  const showToast = vi.fn();
  const hideToast = vi.fn();

  it('projects run events onto the runtime shell', async () => {
    const { createRuntimeShellPresenter } = await import(`../agent-presentation?test=${Date.now()}-shell`);
    const presenter = createRuntimeShellPresenter(shell);

    presenter.beginRun();
    expect(shell.beginAgentRun).toHaveBeenCalledTimes(1);

    presenter.status('run-1', 'Checking recent messages');
    expect(shell.showAgentStatus).toHaveBeenCalledWith('run-1', 'Checking recent messages');

    presenter.streaming('run-1', 'Here is what I found.');
    expect(shell.showAgentStreaming).toHaveBeenCalledWith('run-1', 'Here is what I found.');

    const expiresAt = new Date(Date.now() + 30000).toISOString();
    presenter.approval({
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      serverId: 'mail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: { to: 'a@example.com' },
      expiresAt,
    });
    expect(shell.showAgentApproval).toHaveBeenCalledWith(expect.objectContaining({
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      expiresAt,
    }));

    presenter.completed('run-1', 'Done', ['Read 3 messages']);
    expect(shell.showAgentCompleted).toHaveBeenCalledWith('run-1', 'Done', ['Read 3 messages']);

    presenter.failed('run-1', 'Provider failed');
    expect(shell.showAgentFailed).toHaveBeenCalledWith('run-1', 'Provider failed');

    presenter.cancelled('run-1');
    expect(shell.clearAgentRun).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy toast contract for the rollback window', async () => {
    const { createLegacyToastPresenter } = await import(`../agent-presentation?test=${Date.now()}-legacy`);
    const presenter = createLegacyToastPresenter(showToast, hideToast);

    presenter.beginRun();
    expect(showToast).not.toHaveBeenCalled();

    presenter.status('run-1', 'Checking recent messages');
    expect(showToast).toHaveBeenLastCalledWith({
      kind: 'status',
      agentRunId: 'run-1',
      message: 'Checking recent messages',
    });

    presenter.streaming('run-1', 'Here is what I found.');
    expect(showToast).toHaveBeenLastCalledWith({
      kind: 'streaming',
      agentRunId: 'run-1',
      response: 'Here is what I found.',
    });

    const expiresAt = new Date(Date.now() + 30000).toISOString();
    showToast.mockClear();
    presenter.approval({
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      serverId: 'mail',
      serverDisplayName: 'Gmail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: { to: 'a@example.com' },
      expiresAt,
    });
    // Legacy windows show one toast at a time: the waiting status precedes the
    // approval card exactly as before the shared shell existed.
    expect(showToast).toHaveBeenNthCalledWith(1, {
      kind: 'status',
      agentRunId: 'run-1',
      message: 'Waiting for approval: mail.send_message',
    });
    expect(showToast).toHaveBeenNthCalledWith(2, {
      kind: 'approval',
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      serverId: 'mail',
      serverDisplayName: 'Gmail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: { to: 'a@example.com' },
      expiresAt,
    });

    presenter.completed('run-1', 'Done', []);
    expect(showToast).toHaveBeenLastCalledWith({ kind: 'completed', agentRunId: 'run-1', response: 'Done', toolSummary: [] });

    presenter.failed('run-1', 'Provider failed');
    expect(showToast).toHaveBeenLastCalledWith({ kind: 'failed', agentRunId: 'run-1', error: 'Provider failed' });

    showToast.mockClear();
    presenter.cancelled('run-1');
    expect(showToast).not.toHaveBeenCalled();
    expect(hideToast).toHaveBeenCalledTimes(1);
  });
});
