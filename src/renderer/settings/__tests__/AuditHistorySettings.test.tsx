import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { AuditHistorySettings } from '../AuditHistorySettings';
import type { SettingsIpc } from '../settings-ipc';
import type { AuditEventDetail, AuditRunSummary } from '../../../types/ipc';

describe('AuditHistorySettings live refresh backpressure', () => {
  afterEach(() => {
    cleanup();
  });

  it('debounces live updates and avoids duplicate parallel summary/detail queries', async () => {
    const timers: Array<() => void> = [];
    let listener: ((runId: string) => void) | undefined;
    const runs: AuditRunSummary[] = [
      {
        agentRunId: 'run-1',
        startedAt: '2026-06-25T10:00:00.000Z',
        transcript: 'Active run',
        status: 'running',
        tools: [],
      },
    ];
    const detail: AuditEventDetail[] = [
      { id: 1, agentRunId: 'run-1', eventType: 'run_started', payload: { transcript: 'Active run' }, createdAt: '2026-06-25T10:00:00.000Z' },
    ];
    const settingsIpc: SettingsIpc = {
      getAuditRuns: mock(() => Promise.resolve(runs)),
      getAuditRunDetail: mock(() => Promise.resolve(detail)),
      onAuditRunUpdated: mock((callback: (runId: string) => void) => {
        listener = callback;
        return () => {};
      }),
      getShortcutsPaused: mock(() => Promise.resolve(false)),
      setShortcutsPaused: mock((paused: boolean) => Promise.resolve(paused)),
      beginShortcutCapture: mock(() => Promise.resolve()),
      endShortcutCapture: mock(() => Promise.resolve()),
      onShortcutsPausedChanged: mock(() => undefined),
      getConfig: mock(() => Promise.resolve({} as any)),
      setConfig: mock(() => Promise.resolve()),
      getAppInfo: mock(() => Promise.resolve({} as any)),
      getUpdateStatus: mock(() => Promise.resolve({} as any)),
      checkForUpdates: mock(() => Promise.resolve({} as any)),
      testMcpServer: mock(() => Promise.resolve()),
      checkTranscriptionServer: mock(() => Promise.resolve(true)),
      onUpdateStatusChanged: mock(() => undefined),
      onMcpServerStatus: mock(() => undefined),
      getCredentialStatus: mock(() => Promise.resolve({ available: true, exists: false })),
      saveCredential: mock(() => Promise.resolve({ available: true, exists: true })),
      removeCredential: mock(() => Promise.resolve({ available: true, exists: false })),
    };

    render(<AuditHistorySettings settingsIpc={settingsIpc} />);

    await waitFor(() => {
      expect(settingsIpc.getAuditRuns).toHaveBeenCalledTimes(1);
      expect(settingsIpc.getAuditRunDetail).toHaveBeenCalledTimes(1);
    });

    const setTimeoutSpy = spyOn(window, 'setTimeout').mockImplementation((callback: () => void) => {
      timers.push(callback);
      return timers.length as unknown as number;
    });
    const clearTimeoutSpy = spyOn(window, 'clearTimeout').mockImplementation(() => {});

    try {
      act(() => {
        listener?.('run-1');
        listener?.('run-1');
        listener?.('run-1');
      });

      expect(settingsIpc.getAuditRuns).toHaveBeenCalledTimes(1);
      expect(settingsIpc.getAuditRunDetail).toHaveBeenCalledTimes(1);

      await act(async () => {
        timers.at(-1)?.();
        await Promise.resolve();
      });

      expect(settingsIpc.getAuditRuns).toHaveBeenCalledTimes(2);
      expect(settingsIpc.getAuditRunDetail).toHaveBeenCalledTimes(2);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('renders final responses as markdown for readability', async () => {
    const runs: AuditRunSummary[] = [
      {
        agentRunId: 'run-1',
        startedAt: '2026-06-25T10:00:00.000Z',
        transcript: 'Active run',
        status: 'completed',
        response: 'Here is **bold text**:\n\n- first item\n- second item',
        tools: [],
      },
    ];
    const settingsIpc: SettingsIpc = {
      getAuditRuns: mock(() => Promise.resolve(runs)),
      getAuditRunDetail: mock(() => Promise.resolve([])),
      onAuditRunUpdated: mock(() => undefined),
      getShortcutsPaused: mock(() => Promise.resolve(false)),
      setShortcutsPaused: mock((paused: boolean) => Promise.resolve(paused)),
      beginShortcutCapture: mock(() => Promise.resolve()),
      endShortcutCapture: mock(() => Promise.resolve()),
      onShortcutsPausedChanged: mock(() => undefined),
      getConfig: mock(() => Promise.resolve({} as any)),
      setConfig: mock(() => Promise.resolve()),
      getAppInfo: mock(() => Promise.resolve({} as any)),
      getUpdateStatus: mock(() => Promise.resolve({} as any)),
      checkForUpdates: mock(() => Promise.resolve({} as any)),
      testMcpServer: mock(() => Promise.resolve()),
      checkTranscriptionServer: mock(() => Promise.resolve(true)),
      onUpdateStatusChanged: mock(() => undefined),
      onMcpServerStatus: mock(() => undefined),
      getCredentialStatus: mock(() => Promise.resolve({ available: true, exists: false })),
      saveCredential: mock(() => Promise.resolve({ available: true, exists: true })),
      removeCredential: mock(() => Promise.resolve({ available: true, exists: false })),
    };

    const { container } = render(<AuditHistorySettings settingsIpc={settingsIpc} />);

    await waitFor(() => {
      expect(screen.getByText('bold text')).toBeInTheDocument();
    });

    expect(container.querySelector('strong')?.textContent).toBe('bold text');
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });
});
