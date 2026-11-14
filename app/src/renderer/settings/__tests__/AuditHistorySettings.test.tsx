import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuditHistorySettings } from '../AuditHistorySettings';
import { filterAuditRuns, summarizeRunError } from '../audit-history-model';
import type { SettingsIpc } from '../settings-ipc';
import type { AuditEventDetail, AuditRunSummary } from '../../../types/ipc';

const unused = () => Promise.reject(new Error('unused'));

function auditIpc(overrides: Pick<SettingsIpc, 'getAuditRuns' | 'getAuditRunDetail'> & Partial<SettingsIpc>): SettingsIpc {
  return {
    onAuditRunUpdated: mock(() => undefined),
    getShortcutsPaused: mock(() => Promise.resolve(false)),
    setShortcutsPaused: mock((paused: boolean) => Promise.resolve(paused)),
    beginShortcutCapture: mock(() => Promise.resolve()),
    endShortcutCapture: mock(() => Promise.resolve()),
    onShortcutsPausedChanged: mock(() => undefined),
    getConfig: mock(unused),
    setConfig: mock(() => Promise.resolve()),
    patchTranscriptionConfig: mock(unused),
    getAppInfo: mock(unused),
    getReleaseNotes: mock(() => Promise.resolve(null)),
    getUpdateStatus: mock(unused),
    checkForUpdates: mock(unused),
    testMcpServer: mock(() => Promise.resolve()),
    getMcpStatusSnapshot: mock(() => Promise.resolve({ revision: 0, servers: [] })),
    checkTranscriptionServer: mock(() => Promise.resolve(true)),
    checkTranscriptionReadiness: mock(() => Promise.resolve({ providerId: 'local-whisper-cpp', state: 'ready', message: 'ready', checkedAt: null })),
    onUpdateStatusChanged: mock(() => undefined),
    onNavigateRequested: mock(() => undefined),
    onMcpStatusSnapshot: mock(() => undefined),
    onTranscriptionReadinessChanged: mock(() => undefined),
    getDesktopStatus: mock(unused),
    setWaylandInsertion: mock(unused),
    onDesktopStatusChanged: mock(() => undefined),
    getManagedLocalModel: mock(unused),
    installManagedLocalModel: mock(unused),
    deleteManagedLocalModel: mock(unused),
    onManagedLocalModelStateChanged: mock(() => undefined),
    onOnboardingCompleted: mock(() => undefined),
    onAgentConfigChanged: mock(() => () => {}),
    onCredentialChanged: mock(() => undefined),
    getCredentialStatus: mock(() => Promise.resolve({ available: true, exists: false })),
    saveCredential: mock(() => Promise.resolve({ available: true, exists: true })),
    removeCredential: mock(() => Promise.resolve({ available: true, exists: false })),
    validateAgentProvider: mock(() => Promise.resolve({ issues: [], credentials: 'available' as const })),
    testAgentProvider: mock(unused),
    cancelAgentProviderTest: mock(() => Promise.resolve()),
    onAgentProviderInvalidated: mock(() => undefined),
    getChatGptStatus: mock(() => Promise.resolve({ state: 'signed-out' as const })),
    signInChatGpt: mock(unused),
    signOutChatGpt: mock(() => Promise.resolve({ state: 'signed-out' as const })),
    listChatGptModels: mock(() => Promise.resolve([])),
    onChatGptChanged: mock(() => undefined),
    listSkills: mock(() => Promise.resolve([])),
    readSkill: mock(unused),
    saveSkill: mock(unused),
    selectSkillImport: mock(() => Promise.resolve(null)),
    importSkill: mock(unused),
    removeSkill: mock(unused),
    openSkillsFolder: mock(() => Promise.resolve()),
    getMemory: mock(unused),
    editMemoryFact: mock(unused),
    removeMemoryFact: mock(unused),
    clearMemory: mock(unused),
    onMemoryChanged: mock(() => undefined),
    ...overrides,
  };
}

const activeRun: AuditRunSummary = {
  agentRunId: 'run-1',
  startedAt: '2026-06-25T10:00:00.000Z',
  transcript: 'Active run',
  status: 'running',
  tools: [],
};
const startedEvent: AuditEventDetail = {
  id: 1, agentRunId: 'run-1', eventType: 'run_started', payload: { transcript: 'Active run' }, createdAt: '2026-06-25T10:00:00.000Z',
};

describe('AuditHistorySettings live refresh backpressure', () => {
  afterEach(() => {
    cleanup();
  });

  it('debounces live updates and avoids duplicate parallel summary/detail queries', async () => {
    const timers: Array<() => void> = [];
    let listener: ((runId: string) => void) | undefined;
    let failRefresh = false;
    const settingsIpc = auditIpc({
      getAuditRuns: mock(() => failRefresh ? Promise.reject(new Error('offline')) : Promise.resolve([activeRun])),
      getAuditRunDetail: mock(() => failRefresh ? Promise.reject(new Error('offline')) : Promise.resolve([startedEvent])),
      onAuditRunUpdated: mock((callback: (runId: string) => void) => {
        listener = callback;
        return () => {};
      }),
    });

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
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

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

      failRefresh = true;
      act(() => listener?.('run-1'));
      await act(async () => {
        timers.at(-1)?.();
        await Promise.resolve();
      });
      expect(screen.getByRole('option', { name: /Active run/ })).toBeInTheDocument();
      expect(screen.getByText('Started')).toBeInTheDocument();
      expect(screen.getByText("Couldn't load run history.")).toBeInTheDocument();
      expect(screen.getByText("Couldn't load events for this run.")).toBeInTheDocument();
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('keeps the shown timeline when the user clicks the selected run again, and retries a failed one', async () => {
    let failDetail = true;
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const settingsIpc = auditIpc({
      getAuditRuns: mock(() => Promise.resolve([activeRun])),
      getAuditRunDetail: mock(() => failDetail ? Promise.reject(new Error('offline')) : Promise.resolve([startedEvent])),
    });

    try {
      render(<AuditHistorySettings settingsIpc={settingsIpc} />);
      expect(await screen.findByText("Couldn't load events for this run.")).toBeInTheDocument();

      failDetail = false;
      fireEvent.click(await screen.findByRole('option', { name: /Active run/ }));
      expect(await screen.findByText('Started')).toBeInTheDocument();
      expect(screen.queryByText("Couldn't load events for this run.")).toBeNull();
      expect(settingsIpc.getAuditRunDetail).toHaveBeenCalledTimes(2);

      fireEvent.click(screen.getByRole('option', { name: /Active run/ }));
      expect(screen.getByText('Started')).toBeInTheDocument();
      expect(screen.queryByText('Loading events…')).toBeNull();
      expect(settingsIpc.getAuditRunDetail).toHaveBeenCalledTimes(2);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('renders final responses as markdown for readability', async () => {
    const settingsIpc = auditIpc({
      getAuditRuns: mock(() => Promise.resolve([{
        ...activeRun,
        status: 'completed' as const,
        response: 'Here is **bold text**:\n\n- first item\n- second item',
      }])),
      getAuditRunDetail: mock(() => Promise.resolve([])),
    });

    const { container } = render(<AuditHistorySettings settingsIpc={settingsIpc} />);

    await waitFor(() => {
      expect(screen.getByText('bold text')).toBeInTheDocument();
    });

    expect(container.querySelector('strong')?.textContent).toBe('bold text');
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });
});

describe('audit history model', () => {
  const run = (agentRunId: string, transcript: string, status: AuditRunSummary['status'], tools: string[] = []): AuditRunSummary => ({
    agentRunId, startedAt: '2026-06-25T10:00:00.000Z', transcript, status, tools,
  });
  const runs = [
    run('a', 'Summarize my inbox', 'completed', ['gmail.search_threads']),
    run('b', 'Book a table', 'failed'),
  ];

  it('matches prompt or tool text case-insensitively and narrows by status', () => {
    expect(filterAuditRuns(runs, 'INBOX', 'all').map((r) => r.agentRunId)).toEqual(['a']);
    expect(filterAuditRuns(runs, 'search_threads', 'all').map((r) => r.agentRunId)).toEqual(['a']);
    expect(filterAuditRuns(runs, '', 'failed').map((r) => r.agentRunId)).toEqual(['b']);
    expect(filterAuditRuns(runs, 'inbox', 'failed')).toEqual([]);
  });

  it('leads provider errors with their human message', () => {
    expect(summarizeRunError('Upstream request failed: payment needed. | HTTP 403 | Response: {}')).toBe('Upstream request failed: payment needed.');
    expect(summarizeRunError('Plain failure')).toBe('Plain failure');
  });
});
