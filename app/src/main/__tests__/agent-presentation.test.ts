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

  it('no longer exports the legacy toast presenter', async () => {
    const presentationModule = await import(`../agent-presentation?test=${Date.now()}-contracted`);

    expect('createLegacyToastPresenter' in presentationModule).toBe(false);
  });
});
