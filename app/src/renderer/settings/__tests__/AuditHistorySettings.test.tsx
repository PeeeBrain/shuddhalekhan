import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { AuditHistorySettings } from '../AuditHistorySettings';
import { filterAuditRuns, summarizeRunError } from '../audit-history-model';
import type { SettingsIpc } from '../settings-ipc';
import type { AuditEventDetail, AuditRunSummary } from '../../../types/ipc';

describe('AuditHistorySettings live refresh backpressure', () => {
  afterEach(() => {
    cleanup();
  });

  it('debounces live updates and avoids duplicate parallel summary/detail queries', async () => {
    const timers: Array<() => void> = [];
    let listener: ((runId: string) => void) | undefined;
    let failRefresh = false;
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
      getAuditRuns: mock(() => failRefresh ? Promise.reject(new Error('offline')) : Promise.resolve(runs)),
      getAuditRunDetail: mock(() => failRefresh ? Promise.reject(new Error('offline')) : Promise.resolve(detail)),
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
      getReleaseNotes: mock(() => Promise.resolve(null)),
      getUpdateStatus: mock(() => Promise.resolve({} as any)),
      checkForUpdates: mock(() => Promise.resolve({} as any)),
      testMcpServer: mock(() => Promise.resolve()),
      getMcpStatusSnapshot: mock(() => Promise.resolve({ revision: 0, servers: [] })),
      checkTranscriptionServer: mock(() => Promise.resolve(true)),
      checkTranscriptionReadiness: mock(() => Promise.resolve({ providerId: 'local-whisper-cpp', state: 'ready', message: 'ready', checkedAt: null })),
      onUpdateStatusChanged: mock(() => undefined),
      onNavigateRequested: mock(() => undefined),
      onMcpStatusSnapshot: mock(() => undefined),
      onTranscriptionReadinessChanged: mock(() => undefined),
      getManagedLocalModel: mock(() => Promise.reject(new Error('unused'))),
      installManagedLocalModel: mock(() => Promise.reject(new Error('unused'))),
      deleteManagedLocalModel: mock(() => Promise.reject(new Error('unused'))),
      onManagedLocalModelStateChanged: mock(() => undefined),
      onOnboardingCompleted: mock(() => undefined),
      onCredentialChanged: mock(() => undefined),
      getCredentialStatus: mock(() => Promise.resolve({ available: true, exists: false })),
      saveCredential: mock(() => Promise.resolve({ available: true, exists: true })),
      removeCredential: mock(() => Promise.resolve({ available: true, exists: false })),
      validateAgentProvider: mock(() => Promise.resolve({ issues: [], credentials: 'available' as const })),
      testAgentProvider: mock(() => Promise.reject(new Error('not used'))),
      cancelAgentProviderTest: mock(() => Promise.resolve()),
      onAgentProviderInvalidated: mock(() => undefined),
      listSkills: mock(() => Promise.resolve([])),
      readSkill: mock(() => Promise.reject(new Error('unused'))),
      saveSkill: mock(() => Promise.reject(new Error('unused'))),
      selectSkillImport: mock(() => Promise.resolve(null)),
      importSkill: mock(() => Promise.reject(new Error('unused'))),
      removeSkill: mock(() => Promise.reject(new Error('unused'))),
      openSkillsFolder: mock(() => Promise.resolve()),
      getMemory: mock(() => Promise.reject(new Error('unused'))),
      editMemoryFact: mock(() => Promise.reject(new Error('unused'))),
      removeMemoryFact: mock(() => Promise.reject(new Error('unused'))),
      clearMemory: mock(() => Promise.reject(new Error('unused'))),
      onMemoryChanged: mock(() => undefined),
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
      getReleaseNotes: mock(() => Promise.resolve(null)),
      getUpdateStatus: mock(() => Promise.resolve({} as any)),
      checkForUpdates: mock(() => Promise.resolve({} as any)),
      testMcpServer: mock(() => Promise.resolve()),
      getMcpStatusSnapshot: mock(() => Promise.resolve({ revision: 0, servers: [] })),
      checkTranscriptionServer: mock(() => Promise.resolve(true)),
      checkTranscriptionReadiness: mock(() => Promise.resolve({ providerId: 'local-whisper-cpp', state: 'ready', message: 'ready', checkedAt: null })),
      onUpdateStatusChanged: mock(() => undefined),
      onNavigateRequested: mock(() => undefined),
      onMcpStatusSnapshot: mock(() => undefined),
      onTranscriptionReadinessChanged: mock(() => undefined),
      getManagedLocalModel: mock(() => Promise.reject(new Error('unused'))),
      installManagedLocalModel: mock(() => Promise.reject(new Error('unused'))),
      deleteManagedLocalModel: mock(() => Promise.reject(new Error('unused'))),
      onManagedLocalModelStateChanged: mock(() => undefined),
      onOnboardingCompleted: mock(() => undefined),
      onCredentialChanged: mock(() => undefined),
      getCredentialStatus: mock(() => Promise.resolve({ available: true, exists: false })),
      saveCredential: mock(() => Promise.resolve({ available: true, exists: true })),
      removeCredential: mock(() => Promise.resolve({ available: true, exists: false })),
      validateAgentProvider: mock(() => Promise.resolve({ issues: [], credentials: 'available' as const })),
      testAgentProvider: mock(() => Promise.reject(new Error('not used'))),
      cancelAgentProviderTest: mock(() => Promise.resolve()),
      onAgentProviderInvalidated: mock(() => undefined),
      listSkills: mock(() => Promise.resolve([])),
      readSkill: mock(() => Promise.reject(new Error('unused'))),
      saveSkill: mock(() => Promise.reject(new Error('unused'))),
      selectSkillImport: mock(() => Promise.resolve(null)),
      importSkill: mock(() => Promise.reject(new Error('unused'))),
      removeSkill: mock(() => Promise.reject(new Error('unused'))),
      openSkillsFolder: mock(() => Promise.resolve()),
      getMemory: mock(() => Promise.reject(new Error('unused'))),
      editMemoryFact: mock(() => Promise.reject(new Error('unused'))),
      removeMemoryFact: mock(() => Promise.reject(new Error('unused'))),
      clearMemory: mock(() => Promise.reject(new Error('unused'))),
      onMemoryChanged: mock(() => undefined),
    };

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
