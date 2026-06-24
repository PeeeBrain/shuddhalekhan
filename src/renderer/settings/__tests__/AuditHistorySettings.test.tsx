import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { act, cleanup, render, waitFor } from '@testing-library/react';
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
      getConfig: mock(() => Promise.resolve({} as any)),
      setConfig: mock(() => Promise.resolve()),
      getAppInfo: mock(() => Promise.resolve({} as any)),
      getUpdateStatus: mock(() => Promise.resolve({} as any)),
      checkForUpdates: mock(() => Promise.resolve({} as any)),
      testMcpServer: mock(() => Promise.resolve()),
      onUpdateStatusChanged: mock(() => undefined),
      onMcpServerStatus: mock(() => undefined),
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
});
