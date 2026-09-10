import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AppConfig, McpStatusSnapshot, UpdateStatus } from '../../../types/ipc';
import { createSettingsIpc } from '../settings-ipc';

const vi = { fn: mock };

const config: AppConfig = {
  whisperUrl: 'http://localhost:8080/inference',
  transcription: {
    activeProvider: 'local-whisper-cpp',
    providers: {
      localWhisperCpp: { endpoint: 'http://localhost:8080/inference' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
      azureSpeech: { endpoint: '', region: '' },
      googleCloudSpeech: { project: '', location: 'global', model: '', credentialSource: 'service-account' },
      nvidiaSpeechNim: { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
      customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
      whisperLiveKit: { baseUrl: 'http://localhost:8000', auth: 'none' },
    },
  },
  selectedDeviceId: null,
  removeFillerWords: true,
  language: 'auto',
  task: 'transcribe',
  dictionary: [],
  pasteStrategy: { default: 'ctrl-v', overrides: {} },
  setupChecklistDismissed: false,
  shortcuts: {
    dictation: { binding: { keyCode: null, modifiers: ['ctrl', 'win'] }, activationMode: 'push-to-talk' },
    agent: { binding: { keyCode: null, modifiers: ['alt', 'win'] }, activationMode: 'push-to-talk' },
  },
  dictation: { mode: 'batch', formatter: null },
  agent: {
    enabled: false,
    provider: {
      baseUrl: '',
      model: '',
      apiKeyEnvVar: '',
      thinkingEnabled: true,
    },
    mcpServers: [],
  },
};

const updateStatus: UpdateStatus = {
  state: 'idle',
  currentVersion: '4.0.0',
  message: 'Shuddhalekhan v4.0.0',
  checkedAt: null,
};

describe('settings IPC adapter', () => {
  let invoke: ReturnType<typeof vi.fn>;
  let subscribe: ReturnType<typeof vi.fn>;
  let ipc: ReturnType<typeof createSettingsIpc>;

  beforeEach(() => {
    invoke = vi.fn((channel: string) => {
      if (channel === 'config:get') return Promise.resolve(config);
      if (channel === 'app:get-info') return Promise.resolve({ name: 'Shuddhalekhan', version: '4.0.0', isPackaged: false });
      if (channel === 'app:get-release-notes') return Promise.resolve({ version: '4.0.0', notes: '- Added release notes' });
      if (channel === 'updater:get-status') return Promise.resolve(updateStatus);
      if (channel === 'updater:check') return Promise.resolve(updateStatus);
      if (channel === 'mcp:get-status-snapshot') return Promise.resolve({ revision: 1, servers: [] });
      if (channel === 'transcription:check-server') return Promise.resolve(true);
      if (channel === 'transcription:check-readiness') return Promise.resolve({
        providerId: 'whisper-live-kit', state: 'ready', message: 'ready', checkedAt: null,
      });
      if (channel === 'shortcuts:get-paused') return Promise.resolve(false);
      if (channel === 'shortcuts:set-paused') return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    subscribe = vi.fn(() => vi.fn());
    ipc = createSettingsIpc({ invoke, subscribe } as never);
  });

  it('loads initial settings data through named methods', async () => {
    await expect(ipc.getConfig()).resolves.toBe(config);
    await expect(ipc.getAppInfo()).resolves.toEqual({ name: 'Shuddhalekhan', version: '4.0.0', isPackaged: false });
    await expect(ipc.getReleaseNotes()).resolves.toEqual({ version: '4.0.0', notes: '- Added release notes' });
    await expect(ipc.getUpdateStatus()).resolves.toBe(updateStatus);
    await expect(ipc.getMcpStatusSnapshot()).resolves.toEqual({ revision: 1, servers: [] });

    expect(invoke).toHaveBeenNthCalledWith(1, 'config:get');
    expect(invoke).toHaveBeenNthCalledWith(2, 'app:get-info');
    expect(invoke).toHaveBeenNthCalledWith(3, 'app:get-release-notes');
    expect(invoke).toHaveBeenNthCalledWith(4, 'updater:get-status');
    expect(invoke).toHaveBeenNthCalledWith(5, 'mcp:get-status-snapshot');
  });

  it('saves config and forwards actions without exposing channel names to callers', async () => {
    await ipc.setConfig('agent', config.agent);
    await ipc.setConfig('removeFillerWords', false);
    await ipc.testMcpServer('mail');
    await ipc.checkTranscriptionServer();
    await ipc.checkTranscriptionReadiness();
    await ipc.checkForUpdates();

    expect(invoke).toHaveBeenCalledWith('config:set', 'agent', config.agent);
    expect(invoke).toHaveBeenCalledWith('config:set', 'removeFillerWords', false);
    expect(invoke).toHaveBeenCalledWith('mcp:test-server', 'mail');
    expect(invoke).toHaveBeenCalledWith('transcription:check-server');
    expect(invoke).toHaveBeenCalledWith('transcription:check-readiness');
    expect(invoke).toHaveBeenCalledWith('updater:check');
  });

  it('controls capture and session-only pause through named methods', async () => {
    await expect(ipc.getShortcutsPaused()).resolves.toBe(false);
    await expect(ipc.setShortcutsPaused(true)).resolves.toBe(true);
    await ipc.beginShortcutCapture();
    await ipc.endShortcutCapture();

    expect(invoke).toHaveBeenCalledWith('shortcuts:get-paused');
    expect(invoke).toHaveBeenCalledWith('shortcuts:set-paused', true);
    expect(invoke).toHaveBeenCalledWith('shortcuts:begin-capture');
    expect(invoke).toHaveBeenCalledWith('shortcuts:end-capture');

    const changed = vi.fn();
    ipc.onShortcutsPausedChanged(changed);
    expect(subscribe).toHaveBeenLastCalledWith('shortcuts:paused-changed', expect.any(Function));
  });

  it('exposes credential status and mutation methods without returning saved values', async () => {
    await ipc.getCredentialStatus('agent-api-key');
    await ipc.saveCredential('agent-api-key', 'entered-once-secret');
    await ipc.removeCredential('agent-api-key');

    expect(invoke).toHaveBeenCalledWith('credential:get-status', 'agent-api-key');
    expect(invoke).toHaveBeenCalledWith('credential:save', 'agent-api-key', 'entered-once-secret');
    expect(invoke).toHaveBeenCalledWith('credential:remove', 'agent-api-key');
  });

  it('subscribes to updater and MCP status events', () => {
    const onUpdate = vi.fn();
    const onMcpStatus = vi.fn();
    const offUpdate = vi.fn();
    const offMcp = vi.fn();
    subscribe.mockReturnValueOnce(offUpdate).mockReturnValueOnce(offMcp);

    expect(ipc.onUpdateStatusChanged(onUpdate)).toBe(offUpdate);
    expect(ipc.onMcpStatusSnapshot(onMcpStatus)).toBe(offMcp);

    const snapshot: McpStatusSnapshot = { revision: 3, servers: [{ serverId: 'mail', status: 'connected' }] };
    const updateCallback = subscribe.mock.calls[0]?.[1] as (nextStatus: UpdateStatus) => void;
    const mcpCallback = subscribe.mock.calls[1]?.[1] as (snapshot: McpStatusSnapshot) => void;
    updateCallback(updateStatus);
    mcpCallback(snapshot);

    expect(subscribe).toHaveBeenNthCalledWith(1, 'updater:status-changed', expect.any(Function));
    expect(subscribe).toHaveBeenNthCalledWith(2, 'mcp:status-snapshot', expect.any(Function));
    expect(onUpdate).toHaveBeenCalledWith(updateStatus);
    expect(onMcpStatus).toHaveBeenCalledWith(snapshot);
  });

  it('subscribes to typed transcription readiness updates', () => {
    const onReadiness = vi.fn();
    const off = vi.fn();
    subscribe.mockReturnValueOnce(off);

    expect(ipc.onTranscriptionReadinessChanged(onReadiness)).toBe(off);
    const callback = subscribe.mock.calls[0]?.[1] as (readiness: unknown) => void;
    callback({ state: 'ready' });

    expect(subscribe).toHaveBeenCalledWith('transcription:readiness-changed', expect.any(Function));
    expect(onReadiness).toHaveBeenCalledWith({ state: 'ready' });
  });

  it('subscribes to settings navigation requests', () => {
    const onNavigate = vi.fn();
    const unsubscribe = vi.fn();
    subscribe.mockReturnValueOnce(unsubscribe);

    expect(ipc.onNavigateRequested(onNavigate)).toBe(unsubscribe);
    const callback = subscribe.mock.calls[0]?.[1] as (section: 'about') => void;
    callback('about');

    expect(subscribe).toHaveBeenCalledWith('settings:navigate', expect.any(Function));
    expect(onNavigate).toHaveBeenCalledWith('about');
  });

  it('handles audit log queries and updates', async () => {
    const mockRuns = [{ agentRunId: 'run-1', startedAt: '2026-05-20T12:00:00Z', transcript: 'test prompt', status: 'completed' as const, tools: [] }];
    const mockEvents = [{ id: 1, agentRunId: 'run-1', eventType: 'run_started', payload: {}, createdAt: '2026-05-20T12:00:00Z' }];
    invoke.mockImplementation((channel: string, ...args: any[]) => {
      if (channel === 'audit:get-runs') return Promise.resolve(mockRuns);
      if (channel === 'audit:get-run-detail' && args[0] === 'run-1') return Promise.resolve(mockEvents);
      return Promise.resolve(undefined);
    });

    await expect(ipc.getAuditRuns()).resolves.toEqual(mockRuns);
    await expect(ipc.getAuditRunDetail('run-1')).resolves.toEqual(mockEvents);
    expect(invoke).toHaveBeenCalledWith('audit:get-runs');
    expect(invoke).toHaveBeenCalledWith('audit:get-run-detail', 'run-1');

    const onAuditUpdated = vi.fn();
    const offAudit = vi.fn();
    subscribe.mockReturnValueOnce(offAudit);

    expect(ipc.onAuditRunUpdated(onAuditUpdated)).toBe(offAudit);
    expect(subscribe).toHaveBeenLastCalledWith('audit:run-updated', expect.any(Function));

    const auditCallback = subscribe.mock.calls[subscribe.mock.calls.length - 1]?.[1] as (runId: string) => void;
    auditCallback('run-1');
    expect(onAuditUpdated).toHaveBeenCalledWith('run-1');
  });
});
