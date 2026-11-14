import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { render, screen, cleanup, act, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RuntimeShellSurface } from '../RuntimeShellSurface';
import type { RuntimePresentationSnapshot } from '../../types/ipc';

type Listener = (...args: unknown[]) => void;

const listeners: Record<string, Listener[]> = {};
const send = mock(() => {});
const invoke = mock(() => Promise.resolve());
let rafSpy: ReturnType<typeof spyOn> | null = null;

function mockElectronAPI() {
  for (const key of Object.keys(listeners)) delete listeners[key];
  send.mockClear();
  invoke.mockClear();

  (window as unknown as { electronAPI: unknown }).electronAPI = {
    subscribe: (channel: string, callback: Listener) => {
      if (!listeners[channel]) listeners[channel] = [];
      listeners[channel].push(callback);
      return () => {
        listeners[channel] = (listeners[channel] ?? []).filter((l) => l !== callback);
      };
    },
    send,
    invoke,
  };
}

function emit(channel: string, ...args: unknown[]) {
  (listeners[channel] ?? []).forEach((l) => l(...args));
}

type SnapshotInput = DistributiveOmit<RuntimePresentationSnapshot, 'generation' | 'revision'> & { revision?: number };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function showCard(snapshot: SnapshotInput) {
  act(() => {
    emit('runtime:snapshot', { generation: 1, revision: snapshot.revision ?? 1, ...snapshot });
  });
}

function runFramesSynchronously() {
  // happy-dom never fires requestAnimationFrame on its own.
  rafSpy = spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
    callback(0);
    return 0 as unknown as number;
  });
}

describe('RuntimeShellSurface agent cards', () => {
  afterEach(() => {
    cleanup();
    rafSpy?.mockRestore();
    rafSpy = null;
  });

  it('dismisses a completed card through the runtime channel', async () => {
    const user = userEvent.setup();
    mockElectronAPI();
    render(<RuntimeShellSurface />);

    showCard({
      kind: 'agent-completed',
      agentRunId: 'run-1',
      response: 'All done.',
      toolSummary: [],
      steps: [],
    });

    const dismiss = await screen.findByRole('button', { name: 'Dismiss' });
    await user.click(dismiss);

    expect(send).toHaveBeenCalledWith('runtime:agent-dismiss');
  });

  it('dismisses a failed card through the runtime channel', async () => {
    const user = userEvent.setup();
    mockElectronAPI();
    render(<RuntimeShellSurface />);

    showCard({ kind: 'agent-failed', agentRunId: null, message: 'Provider unreachable.' });

    const dismiss = await screen.findByRole('button', { name: 'Dismiss' });
    await user.click(dismiss);

    expect(send).toHaveBeenCalledWith('runtime:agent-dismiss');
  });

  it('reports measured content height for response cards', async () => {
    runFramesSynchronously();
    mockElectronAPI();
    render(<RuntimeShellSurface />);

    showCard({
      kind: 'agent-streaming',
      agentRunId: 'run-1',
      steps: [{ text: 'A long streamed answer.', tools: [] }],
    });
    showCard({
      kind: 'agent-streaming',
      agentRunId: 'run-1',
      steps: [{ text: 'A long streamed answer that grew.', tools: [] }],
      revision: 2,
    });

    await waitFor(() => {
      const sizeCalls = (send.mock.calls as unknown[][]).filter((call) => call[0] === 'runtime:agent-card-size');
      expect(sizeCalls.length).toBeGreaterThanOrEqual(2);
    });
    for (const call of send.mock.calls as unknown[][]) {
      if (call[0] === 'runtime:agent-card-size') {
        const height = call[1];
        expect(typeof height).toBe('number');
        expect(typeof height === 'number' && Number.isFinite(height)).toBe(true);
        if (typeof height === 'number') expect(height).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('follows a growing response until the user scrolls away', () => {
    mockElectronAPI();
    render(<RuntimeShellSurface />);
    showCard({ kind: 'agent-streaming', agentRunId: 'run-1', steps: [{ text: 'First words.', tools: [] }] });

    // happy-dom has no layout, so emulate a browser box: scrollTop clamps to
    // the scrollable range and every change fires a scroll event.
    const body = screen.getByText('First words.').closest('.overflow-y-auto') as HTMLElement;
    let scrollHeight = 800;
    let scrollTop = 0;
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        const next = Math.max(0, Math.min(value, scrollHeight - 400));
        if (next === scrollTop) return;
        scrollTop = next;
        fireEvent.scroll(body);
      },
    });

    showCard({ kind: 'agent-streaming', agentRunId: 'run-1', steps: [{ text: 'First words. More.', tools: [] }], revision: 2 });
    expect(body.scrollTop).toBe(400);

    // The programmatic scroll's own event must not stop the follow.
    scrollHeight = 1000;
    showCard({ kind: 'agent-streaming', agentRunId: 'run-1', steps: [{ text: 'First words. More. Again.', tools: [] }], revision: 3 });
    expect(body.scrollTop).toBe(600);

    body.scrollTop = 0;
    scrollHeight = 1200;
    showCard({ kind: 'agent-completed', agentRunId: 'run-1', response: 'First words. More. Again. Done.', toolSummary: [], steps: [], revision: 4 });
    expect(body.scrollTop).toBe(0);
  });

  it('keeps what the agent said between tool calls visible, folded once it answers', async () => {
    const user = userEvent.setup();
    mockElectronAPI();
    render(<RuntimeShellSurface />);
    const steps = [{ text: 'Let me search.', tools: ['web_search'] }];

    showCard({ kind: 'agent-streaming', agentRunId: 'run-1', steps: [...steps, { text: 'Found it', tools: [] }] });
    expect(screen.getByText('Let me search.')).toBeTruthy();
    expect(screen.getByText('Found it')).toBeTruthy();

    showCard({ kind: 'agent-completed', agentRunId: 'run-1', response: 'Found it.', toolSummary: [], steps, revision: 2 });
    expect(screen.queryByText('Let me search.')).toBeNull();
    await user.click(screen.getByRole('button', { name: '1 step · web_search' }));
    expect(screen.getByText('Let me search.')).toBeTruthy();
  });

  it('sends approval decisions without optional denial feedback', async () => {
    const user = userEvent.setup();
    mockElectronAPI();
    render(<RuntimeShellSurface />);

    showCard({
      kind: 'agent-approval',
      agentRunId: 'run-1',
      approvalId: 'approval-empty',
      serverId: 'mail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: { to: 'a@example.com' },
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    });

    await screen.findByText('mail:send_message');
    await user.click(await screen.findByRole('button', { name: 'Deny' }));

    expect(invoke).toHaveBeenCalledWith(
      'agent:approval-decision',
      'run-1',
      'approval-empty',
      'denied',
      undefined,
    );
  });

  it('maps card shortcuts to decisions but leaves the denial note typeable', async () => {
    const user = userEvent.setup();
    mockElectronAPI();
    render(<RuntimeShellSurface />);

    showCard({
      kind: 'agent-approval',
      agentRunId: 'run-1',
      approvalId: 'approval-keys',
      serverId: 'mail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: { to: 'a@example.com' },
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    });

    expect(await screen.findByText('Send message')).toBeInTheDocument();
    await user.type(await screen.findByLabelText('Optional denial message'), 'a{Enter}');
    expect(invoke).not.toHaveBeenCalled();

    screen.getByRole('alert').focus();
    await user.keyboard('a');

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'agent:approval-decision',
      'run-1',
      'approval-keys',
      'always-allow',
      undefined,
    );
  });

  it('sends populated denial feedback', async () => {
    const user = userEvent.setup();
    mockElectronAPI();
    render(<RuntimeShellSurface />);

    showCard({
      kind: 'agent-approval',
      agentRunId: 'run-1',
      approvalId: 'approval-feedback',
      serverId: 'mail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: { to: 'a@example.com' },
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    });

    await user.type(
      await screen.findByLabelText('Optional denial message'),
      'Use the other account',
    );
    await user.click(await screen.findByRole('button', { name: 'Deny' }));

    expect(invoke).toHaveBeenCalledWith(
      'agent:approval-decision',
      'run-1',
      'approval-feedback',
      'denied',
      'Use the other account',
    );
  });

  it('allows approval decisions to be retried after IPC rejection', async () => {
    const user = userEvent.setup();
    mockElectronAPI();
    invoke.mockImplementationOnce(() => Promise.reject(new Error('sidecar unavailable')));
    render(<RuntimeShellSurface />);

    showCard({
      kind: 'agent-approval',
      agentRunId: 'run-1',
      approvalId: 'approval-retry',
      serverId: 'mail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: {},
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    });

    await user.click(await screen.findByRole('button', { name: 'Deny' }));

    expect(await screen.findByRole('button', { name: 'Deny' })).toBeEnabled();
    expect(screen.queryByText('Feedback sent. Continuing…')).not.toBeInTheDocument();
  });

  it('keeps denial feedback drafts across preemption round-trips', async () => {
    const user = userEvent.setup();
    mockElectronAPI();
    render(<RuntimeShellSurface />);

    showCard({
      kind: 'agent-approval',
      agentRunId: 'run-1',
      approvalId: 'approval-draft',
      serverId: 'mail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: {},
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    });

    const feedback = await screen.findByLabelText('Optional denial message');
    await user.type(feedback, 'Use the other account');

    // A dictation recording preempts the approval visually.
    showCard({
      kind: 'recording',
      recordingSessionId: 'session-1',
      intent: 'dictation',
      capabilities: { batch: true, streaming: false },
      durationWarningSeconds: null,
      captureStartedAt: null,
    });

    // The approval resurfaces after capture ends; the draft survives.
    showCard({
      kind: 'agent-approval',
      agentRunId: 'run-1',
      approvalId: 'approval-draft',
      serverId: 'mail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: {},
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      revision: 5,
    });

    expect(await screen.findByLabelText('Optional denial message')).toHaveValue('Use the other account');
  });
});

describe('RuntimeShellSurface streaming preview', () => {
  afterEach(cleanup);

  it('labels the preview provisional and shows the tentative tail once after committed words', () => {
    mockElectronAPI();
    render(<RuntimeShellSurface />);

    showCard({
      kind: 'recording',
      recordingSessionId: 'session-1',
      intent: 'agent',
      capabilities: { batch: true, streaming: true },
      durationWarningSeconds: null,
      captureStartedAt: null,
      committed: 'open the',
      tentative: 'open the report',
    });

    const preview = screen.getByTestId('streaming-preview');
    expect(preview).toHaveTextContent(/^Preview\s*open the report$/);
    expect(screen.getByTestId('streaming-committed')).toHaveTextContent('open the');
    expect(screen.getByTestId('streaming-tentative')).toHaveTextContent('report');
  });

  it('keeps the recording timer anchored to capture start across preview revisions', () => {
    let now = 1_000_000;
    const ticks: Array<() => void> = [];
    const spies = [
      spyOn(Date, 'now').mockImplementation(() => now),
      spyOn(window, 'setInterval').mockImplementation(((callback: () => void) => {
        ticks.push(callback);
        return ticks.length;
      }) as typeof setInterval),
      spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0),
    ];
    const advance = (ms: number) => {
      now += ms;
      act(() => ticks.forEach((tick) => tick()));
    };
    try {
      mockElectronAPI();
      render(<RuntimeShellSurface />);
      const recording = {
        kind: 'recording',
        recordingSessionId: 'session-1',
        intent: 'dictation',
        capabilities: { batch: true, streaming: true },
        durationWarningSeconds: null,
      } as const;

      showCard({ ...recording, captureStartedAt: null });
      expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Preparing microphone');

      advance(1000);
      showCard({ ...recording, captureStartedAt: now, revision: 2 });
      advance(3000);
      expect(screen.getByRole('status')).toHaveTextContent('00:03');

      // Each preview delta is a new revision of the same session; the clock keeps running.
      showCard({ ...recording, captureStartedAt: 1_001_000, committed: 'hello', revision: 3 });
      expect(screen.getByRole('status')).toHaveTextContent('00:03');
      advance(2000);
      showCard({ ...recording, captureStartedAt: 1_001_000, committed: 'hello there', revision: 4 });
      expect(screen.getByRole('status')).toHaveTextContent('00:05');
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
