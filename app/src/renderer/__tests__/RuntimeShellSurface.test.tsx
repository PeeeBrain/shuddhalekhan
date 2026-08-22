import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
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
      response: 'A long streamed answer.',
    });
    showCard({
      kind: 'agent-streaming',
      agentRunId: 'run-1',
      response: 'A long streamed answer that grew.',
      revision: 2,
    });

    await waitFor(() => {
      const sizeCalls = (send.mock.calls as unknown[][]).filter((call) => call[0] === 'runtime:agent-card-size');
      expect(sizeCalls.length).toBeGreaterThanOrEqual(2);
    });
    for (const call of send.mock.calls as unknown[][]) {
      if (call[0] === 'runtime:agent-card-size') {
        expect(typeof call[1]).toBe('number');
      }
    }
  });

  it('sends approval decisions with optional denial feedback', async () => {
    const user = userEvent.setup();
    mockElectronAPI();
    render(<RuntimeShellSurface />);

    showCard({
      kind: 'agent-approval',
      agentRunId: 'run-1',
      approvalId: 'approval-1',
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
      'approval-1',
      'denied',
      undefined,
    );
  });

  it('keeps denial feedback drafts across preemption round-trips', async () => {
    const user = userEvent.setup();
    mockElectronAPI();
    render(<RuntimeShellSurface />);

    showCard({
      kind: 'agent-approval',
      agentRunId: 'run-1',
      approvalId: 'approval-1',
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
    });

    // The approval resurfaces after capture ends; the draft survives.
    showCard({
      kind: 'agent-approval',
      agentRunId: 'run-1',
      approvalId: 'approval-1',
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
