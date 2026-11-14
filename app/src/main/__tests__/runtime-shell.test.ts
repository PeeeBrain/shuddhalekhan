import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { readdirSync } from 'node:fs';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

const vi = { fn: mock };
const step = (text: string) => [{ text, tools: [] }];

installElectronMock();

describe('Batch Dictation runtime shell', () => {
  beforeEach(() => {
    resetElectronMock();
    electronMock.screen.getPrimaryDisplay.mockReturnValue({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      workAreaSize: { width: 1920, height: 1080 },
    });
  });

  it('warms one hidden runtime window without starting microphone capture', async () => {
    const send = vi.fn();
    const loadURL = vi.fn();
    const window = {
      webContents: {
        send,
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        isLoading: vi.fn(() => true),
      },
      loadURL,
      loadFile: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => false),
      setPosition: vi.fn(),
      setBounds: vi.fn(), setFocusable: vi.fn(), setIgnoreMouseEvents: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      showInactive: vi.fn(),
      hide: vi.fn(),
      destroy: vi.fn(),
    };
    electronMock.BrowserWindow.mockImplementation(() => window);

    const { RuntimeShell } = await import(`../runtime-shell?test=${Date.now()}`);
    const shell = new RuntimeShell();

    shell.prepare();
    shell.prepare();

    expect(electronMock.BrowserWindow).toHaveBeenCalledTimes(1);
    expect(electronMock.BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
      show: false,
      focusable: false,
      skipTaskbar: true,
    }));
    expect(loadURL).toHaveBeenCalledWith('http://localhost:5173/#/runtime');
    expect(send.mock.calls.map((call: unknown[]) => call[0])).not.toContain('runtime:audio-start');
  });

  it('publishes complete monotonic recording, processing, failure, and idle snapshots', async () => {
    const send = vi.fn();
    const window = {
      webContents: { send, on: vi.fn(), setWindowOpenHandler: vi.fn(), isLoading: vi.fn(() => false) },
      loadURL: vi.fn(), loadFile: vi.fn(), on: vi.fn(), once: vi.fn(),
      isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => false),
      setPosition: vi.fn(), setAlwaysOnTop: vi.fn(), showInactive: vi.fn(),
      setBounds: vi.fn(), setFocusable: vi.fn(), setIgnoreMouseEvents: vi.fn(),
      hide: vi.fn(), destroy: vi.fn(),
    };
    electronMock.BrowserWindow.mockImplementation(() => window);
    const { RuntimeShell } = await import(`../runtime-shell?test=${Date.now()}-snapshots`);
    const shell = new RuntimeShell();
    shell.prepare();
    shell.markReady();
    // A permission check for the new mic must not block commands to an already ready audio host.
    shell.setSelectedDevice('mic-2');

    const envelope = {
      recordingSessionId: 'session-1', sequence: 1, revision: 1,
      capabilities: { batch: true as const, streaming: false },
    };
    shell.beginCapture(envelope);
    shell.show('dictation', 'session-1', envelope);
    shell.markCaptureReady('obsolete-session');
    shell.markCaptureReady('session-1');
    shell.markCaptureReady('session-1');
    shell.updateDurationWarning(10);
    expect(send).toHaveBeenLastCalledWith('runtime:snapshot', expect.objectContaining({ durationWarningSeconds: 10 }));
    shell.showStreamingPreview('session-1', 'Hello ', 'Hello wor');
    shell.showStreamingPreview('session-1', 'Hello ', 'Hello wor');
    shell.showProcessing('session-1');
    shell.showFailure('session-1', 'Paste failed', ['retry-paste', 'copy-full-transcript']);
    expect(window.setFocusable).toHaveBeenLastCalledWith(false);
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: false });
    shell.finish();
    shell.markCaptureReady('session-1');

    const snapshots = (send.mock.calls as unknown[][])
      .filter((call: unknown[]) => call[0] === 'runtime:snapshot')
      .map((call: unknown[]) => call[1] as { kind: string; revision: number; captureStartedAt?: number | null });
    expect(snapshots.map((snapshot: { kind: string }) => snapshot.kind)).toEqual([
      'recording', 'recording', 'recording', 'recording', 'processing', 'failure', 'idle',
    ]);
    expect(snapshots.map((snapshot: { revision: number }) => snapshot.revision)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(snapshots[0].captureStartedAt).toBeNull();
    expect(snapshots[1].captureStartedAt).toEqual(expect.any(Number));
    expect(snapshots[2].captureStartedAt).toBe(snapshots[1].captureStartedAt);
    expect(send).toHaveBeenCalledWith('runtime:audio-start', expect.objectContaining({
      recordingSessionId: 'session-1', sequence: 1,
    }));
    expect(send).toHaveBeenCalledWith('recording:pill-hide');
    expect(window.setFocusable).not.toHaveBeenCalledWith(true);
    const command = (send.mock.calls as unknown[][]).find((call: unknown[]) => call[0] === 'runtime:audio-start')?.[1] as { generation: number };
    expect(shell.acceptsAudioEvent(command.generation, 'session-1', 1)).toBe(false);
  });

  it('ignores late streaming previews after failure clears the active recording', async () => {
    const send = vi.fn();
    const window = {
      webContents: { send, on: vi.fn(), setWindowOpenHandler: vi.fn(), isLoading: vi.fn(() => false) },
      loadURL: vi.fn(), loadFile: vi.fn(), on: vi.fn(), once: vi.fn(),
      isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => true),
      setPosition: vi.fn(), setAlwaysOnTop: vi.fn(), showInactive: vi.fn(),
      setBounds: vi.fn(), setFocusable: vi.fn(), setIgnoreMouseEvents: vi.fn(),
      hide: vi.fn(), destroy: vi.fn(),
    };
    electronMock.BrowserWindow.mockImplementation(() => window);
    const { RuntimeShell } = await import(`../runtime-shell?test=${Date.now()}-late-preview`);
    const shell = new RuntimeShell();
    shell.prepare();
    shell.markReady();

    const envelope = {
      recordingSessionId: 'session-1', sequence: 1, revision: 1,
      capabilities: { batch: true as const, streaming: true },
    };
    shell.beginCapture(envelope);
    shell.show('dictation', 'session-1', envelope);
    shell.showStreamingPreview('session-1', 'Hello ', 'Hello world');
    shell.showFailure('session-1', 'Paste failed', ['retry-paste']);
    send.mockClear();
    shell.showStreamingPreview('session-1', 'late', 'late text');

    expect(send).not.toHaveBeenCalled();
  });

  it('replaces provisional preview text while preserving the original recording identity', async () => {
    const send = vi.fn();
    const window = {
      webContents: { send, on: vi.fn(), setWindowOpenHandler: vi.fn(), isLoading: vi.fn(() => false) },
      loadURL: vi.fn(), loadFile: vi.fn(), on: vi.fn(), once: vi.fn(),
      isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => false),
      setPosition: vi.fn(), setAlwaysOnTop: vi.fn(), showInactive: vi.fn(),
      setBounds: vi.fn(), setFocusable: vi.fn(), setIgnoreMouseEvents: vi.fn(),
      hide: vi.fn(), destroy: vi.fn(),
    };
    electronMock.BrowserWindow.mockImplementation(() => window);
    const { RuntimeShell } = await import(`../runtime-shell?test=${Date.now()}-halted-preview`);
    const shell = new RuntimeShell();
    shell.prepare();
    shell.markReady();

    const envelope = {
      recordingSessionId: 'session-1', sequence: 1, revision: 1,
      capabilities: { batch: true as const, streaming: true },
    };
    shell.beginCapture(envelope);
    shell.show('dictation', 'session-1', envelope);
    shell.showStreamingPreview('session-1', 'Old', 'Old words');
    shell.showStreamingPreview('session-1', 'Hello', 'Hello world');

    const snapshot = send.mock.calls.at(-1)?.[1];
    expect(snapshot.recordingSessionId).toBe('session-1');
    expect(snapshot.committed).toBe('Hello');
    expect(snapshot.tentative).toBe('Hello world');
  });

  it('hides synchronously before insertion and can show a later failure', async () => {
    let visible = true;
    const setTimeoutFn = vi.fn();
    const window = {
      webContents: { send: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn(), isLoading: vi.fn(() => false) },
      loadURL: vi.fn(), loadFile: vi.fn(), on: vi.fn(), once: vi.fn(),
      isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => visible),
      setPosition: vi.fn(), setAlwaysOnTop: vi.fn(),
      showInactive: vi.fn(() => { visible = true; }),
      setBounds: vi.fn(), setFocusable: vi.fn(), setIgnoreMouseEvents: vi.fn(),
      hide: vi.fn(() => { visible = false; }), destroy: vi.fn(),
    };
    electronMock.BrowserWindow.mockImplementation(() => window);
    const { RuntimeShell } = await import(`../runtime-shell?test=${Date.now()}-hide-before-insertion`);
    const shell = new RuntimeShell({ setTimeoutFn, clearTimeoutFn: vi.fn() });
    shell.prepare();

    shell.finish();

    expect(window.hide).toHaveBeenCalledTimes(1);
    expect(setTimeoutFn).not.toHaveBeenCalled();

    shell.showFailure('session-1', 'Paste failed', ['retry-paste']);
    expect(window.showInactive).toHaveBeenCalledTimes(1);
  });

  it('accepts returned audio only for the current generation, session, and sequence', async () => {
    const send = vi.fn();
    const window = {
      webContents: { send, on: vi.fn(), setWindowOpenHandler: vi.fn(), isLoading: vi.fn(() => false) },
      loadURL: vi.fn(), loadFile: vi.fn(), on: vi.fn(), once: vi.fn(),
      isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => false),
      setPosition: vi.fn(), setAlwaysOnTop: vi.fn(), showInactive: vi.fn(),
      setBounds: vi.fn(), setFocusable: vi.fn(), setIgnoreMouseEvents: vi.fn(),
      hide: vi.fn(), destroy: vi.fn(),
    };
    electronMock.BrowserWindow.mockImplementation(() => window);
    const { RuntimeShell } = await import(`../runtime-shell?test=${Date.now()}-identity`);
    const shell = new RuntimeShell();
    shell.prepare();
    shell.markReady();
    shell.beginCapture({
      recordingSessionId: 'current', sequence: 7, revision: 7,
      capabilities: { batch: true, streaming: false },
    });
    const command = (send.mock.calls as unknown[][]).find((call: unknown[]) => call[0] === 'runtime:audio-start')?.[1] as { generation: number };

    expect(shell.acceptsAudioEvent(command.generation, 'current', 7)).toBe(true);
    expect(shell.acceptsAudioEvent(command.generation, 'stale', 7)).toBe(false);
    expect(shell.acceptsAudioEvent(command.generation - 1, 'current', 7)).toBe(false);
    expect(shell.acceptsAudioEvent(command.generation, 'current', 6)).toBe(false);
    shell.cancelCapture();
    expect(send).toHaveBeenCalledWith('runtime:audio-cancel', expect.objectContaining({
      generation: command.generation, recordingSessionId: 'current', sequence: 7,
    }));
    expect(shell.consumeAudioEvent(command.generation, 'current', 7)).toBe(false);
  });

  it('delivers spooled audio only after the end boundary matches, and fails recoverably on a lost chunk', async () => {
    const send = vi.fn();
    const window = {
      webContents: { send, on: vi.fn(), setWindowOpenHandler: vi.fn(), isLoading: vi.fn(() => false) },
      loadURL: vi.fn(), loadFile: vi.fn(), on: vi.fn(), once: vi.fn(),
      isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => false),
      setPosition: vi.fn(), setAlwaysOnTop: vi.fn(), showInactive: vi.fn(),
      setBounds: vi.fn(), setFocusable: vi.fn(), setIgnoreMouseEvents: vi.fn(),
      hide: vi.fn(), destroy: vi.fn(),
    };
    electronMock.BrowserWindow.mockImplementation(() => window);
    const { RuntimeShell } = await import(`../runtime-shell?test=${Date.now()}-spool`);
    const { defaultSpoolDir } = await import('../audio-spool');
    const shell = new RuntimeShell();
    const onAudioData = vi.fn(async () => {});
    const onAudioFailed = vi.fn();
    shell.setRecordingHandlers({ onAudioData, onAudioFailed, onCrash: vi.fn() });
    const handler = (calls: unknown[][], channel: string) => calls
      .filter((call) => call[0] === channel).at(-1)?.[1] as (...args: unknown[]) => unknown;
    const spool = handler(electronMock.ipcMain.handle.mock.calls as unknown[][], 'runtime:audio-spool');
    const end = handler(electronMock.ipcMain.on.mock.calls as unknown[][], 'runtime:audio-end');
    const ownSpools = () => {
      try {
        return readdirSync(defaultSpoolDir()).filter((name) => name.startsWith(`capture-${process.pid}-`));
      } catch {
        return [];
      }
    };
    const event = { sender: window.webContents };
    const pcm = (...samples: number[]) => Int16Array.from(samples).buffer;
    shell.prepare();
    shell.markReady();
    const begin = (sequence: number) => {
      shell.beginCapture({
        recordingSessionId: 'take', sequence, revision: sequence,
        capabilities: { batch: true, streaming: false },
      });
      const start = (send.mock.calls as unknown[][]).filter((call) => call[0] === 'runtime:audio-start').at(-1);
      const command = start?.[1] as { generation: number };
      return command.generation;
    };

    const generation = begin(1);
    // The acknowledgement is what returns the renderer's write credit.
    expect(spool(event, generation, 'take', 1, 0, pcm(1, 2))).toBe(true);
    expect(spool({ sender: {} }, generation, 'take', 1, 1, pcm(9))).toBe(false); // foreign sender
    expect(spool(event, generation, 'stale', 1, 1, pcm(9))).toBe(false); // stale identity
    expect(spool(event, generation, 'take', 1, 1, pcm(3))).toBe(true);
    expect(ownSpools()).toHaveLength(1);
    end(event, generation, 'take', 1, 2, 3);

    const delivered = onAudioData.mock.calls[0] as unknown as unknown[];
    expect(delivered.slice(1, 4)).toEqual([generation, 'take', 1]);
    const wav = delivered[4] as ArrayBuffer;
    expect(Array.from(new Int16Array(wav.slice(44)))).toEqual([1, 2, 3]);
    expect(shell.acceptsAudioEvent(generation, 'take', 1)).toBe(false);
    expect(ownSpools()).toEqual([]);

    // The final chunk never reached main: no WAV, mic released, one failure, no file left.
    const second = begin(2);
    spool(event, second, 'take', 2, 0, pcm(4));
    end(event, second, 'take', 2, 2, 2);
    expect(onAudioFailed).toHaveBeenCalledWith(event, second, 'take', 2);
    expect(send).toHaveBeenCalledWith('runtime:audio-cancel', expect.objectContaining({ generation: second, sequence: 2 }));
    expect(onAudioData).toHaveBeenCalledTimes(1);
    expect(ownSpools()).toEqual([]);

    // Cancel discards a partially spooled recording without producing audio.
    const third = begin(3);
    spool(event, third, 'take', 3, 0, pcm(5));
    shell.cancelCapture();
    expect(ownSpools()).toEqual([]);
    end(event, third, 'take', 3, 1, 1);
    expect(onAudioData).toHaveBeenCalledTimes(1);

    // Disk full: the write is refused, the recording fails once, and nothing is left behind.
    const fourth = begin(4);
    expect(spool(event, fourth, 'take', 4, 0, pcm(6))).toBe(true);
    const write = spyOn(fs, 'writeSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    try {
      expect(spool(event, fourth, 'take', 4, 1, pcm(7))).toBe(false);
    } finally {
      write.mockRestore();
    }
    expect(onAudioFailed).toHaveBeenCalledWith(event, fourth, 'take', 4);
    expect(send).toHaveBeenCalledWith('runtime:audio-cancel', expect.objectContaining({ generation: fourth, sequence: 4 }));
    expect(ownSpools()).toEqual([]);
    expect(spool(event, fourth, 'take', 4, 2, pcm(8))).toBe(false);
    shell.destroy();
  });

  it.each(['render-process-gone', 'unresponsive'])('releases a %s renderer and recreates one recoverable generation', async (event: string) => {
    const onCrash = vi.fn();
    const windows: any[] = [];
    electronMock.BrowserWindow.mockImplementation(() => {
      const handlers = new Map<string, (...args: any[]) => void>();
      const webHandlers = new Map<string, (...args: any[]) => void>();
      const window = {
        handlers, webHandlers,
        webContents: {
          send: vi.fn(), isLoading: vi.fn(() => true), setWindowOpenHandler: vi.fn(),
          on: vi.fn((event: string, handler: (...args: any[]) => void) => webHandlers.set(event, handler)),
        },
        loadURL: vi.fn(), loadFile: vi.fn(),
        on: vi.fn((event: string, handler: (...args: any[]) => void) => handlers.set(event, handler)),
        once: vi.fn(), isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => false),
        setPosition: vi.fn(), setAlwaysOnTop: vi.fn(), showInactive: vi.fn(), hide: vi.fn(),
        destroy: vi.fn(), setBounds: vi.fn(), setFocusable: vi.fn(), setIgnoreMouseEvents: vi.fn(),
      };
      windows.push(window);
      return window;
    });
    const { RuntimeShell } = await import(`../runtime-shell?test=${Date.now()}-crash`);
    const shell = new RuntimeShell();
    shell.setRecordingHandlers({ onCrash, onAudioData: async () => {}, onAudioFailed: () => {} });
    shell.prepare();
    shell.markReady();
    shell.beginCapture({
      recordingSessionId: 'doomed', sequence: 1, revision: 1,
      capabilities: { batch: true, streaming: false },
    });
    const oldCommand = (windows[0].webContents.send.mock.calls as unknown[][])
      .find((call) => call[0] === 'runtime:audio-start')?.[1] as any;

    if (event === 'unresponsive') windows[0].handlers.get(event)?.();
    else windows[0].webHandlers.get(event)?.({}, { reason: 'crashed' });
    expect(windows).toHaveLength(2);
    expect(windows[0].destroy).toHaveBeenCalledTimes(1);
    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(shell.acceptsAudioEvent(oldCommand.generation, 'doomed', 1)).toBe(false);
    windows[0].webHandlers.get('render-process-gone')?.({}, { reason: 'killed' });
    expect(onCrash).toHaveBeenCalledTimes(1);

    shell.showFailure('doomed', 'Recording renderer crashed.');
    windows[1].webHandlers.get('did-finish-load')?.();
    expect(windows[1].webContents.send).toHaveBeenCalledWith(
      'runtime:snapshot',
      expect.objectContaining({ kind: 'failure', generation: oldCommand.generation + 1, revision: 1 }),
    );
  });
});

describe('Agent Mode runtime shell presentation', () => {
  beforeEach(() => {
    resetElectronMock();
    electronMock.screen.getPrimaryDisplay.mockReturnValue({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      workAreaSize: { width: 1920, height: 1080 },
    });
  });

  function createWindowMock(send = vi.fn()) {
    return {
      send,
      window: {
        webContents: { send, on: vi.fn(), setWindowOpenHandler: vi.fn(), isLoading: vi.fn(() => false) },
        loadURL: vi.fn(), loadFile: vi.fn(), on: vi.fn(), once: vi.fn(),
        isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => false),
        setPosition: vi.fn(), setAlwaysOnTop: vi.fn(), showInactive: vi.fn(),
        setBounds: vi.fn(), setFocusable: vi.fn(), setIgnoreMouseEvents: vi.fn(),
        hide: vi.fn(), destroy: vi.fn(),
      },
    };
  }

  function snapshotsOf(send: ReturnType<typeof vi.fn>): Array<{ kind: string; revision: number } & Record<string, unknown>> {
    return (send.mock.calls as unknown[][])
      .filter((call: unknown[]) => call[0] === 'runtime:snapshot')
      .map((call: unknown[]) => call[1] as { kind: string; revision: number } & Record<string, unknown>);
  }

  function createShell(moduleSuffix: string, timers?: { setTimeoutFn: typeof setTimeout; clearTimeoutFn: typeof clearTimeout }) {
    return import(`../runtime-shell?test=${Date.now()}-${moduleSuffix}`).then(({ RuntimeShell }) => new RuntimeShell(timers));
  }

  it('projects agent status as a transient snapshot and returns to idle after the status window', async () => {
    const timers: Array<{ fn: () => void; delay: number }> = [];
    const setTimeoutFn = vi.fn((fn: () => void, delay: number) => {
      timers.push({ fn, delay });
      return timers.length - 1;
    }) as unknown as typeof setTimeout;
    const { send, window } = createWindowMock();
    electronMock.BrowserWindow.mockImplementation(() => window);
    const shell = await createShell('agent-status', { setTimeoutFn, clearTimeoutFn: vi.fn() as unknown as typeof clearTimeout });
    shell.prepare();

    shell.showAgentStatus('run-1', 'Checking recent messages');

    expect(snapshotsOf(send).at(-1)).toMatchObject({
      kind: 'agent-status',
      agentRunId: 'run-1',
      message: 'Checking recent messages',
      generation: 1,
    });
    // Cards accept pointer input so long responses can scroll; they never
    // take keyboard focus.
    expect(window.setFocusable).toHaveBeenLastCalledWith(false);
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: false });
    expect(window.showInactive).toHaveBeenCalled();

    timers.length = 0;
    shell.showAgentStatus('run-1', 'Reading messages');
    expect(timers).toHaveLength(1);
    (timers[0].fn as () => void)();

    expect(snapshotsOf(send).at(-1)).toMatchObject({ kind: 'idle' });
    expect(window.hide).toHaveBeenCalled();
  });

  it('ignores blank streamed prefixes and coalesces token deltas into one publish per interval', async () => {
    const timers: Array<() => void> = [];
    const setTimeoutFn = vi.fn((fn: () => void) => timers.push(fn)) as unknown as typeof setTimeout;
    const { send, window } = createWindowMock();
    electronMock.BrowserWindow.mockImplementation(() => window);
    const shell = await createShell('agent-streaming', { setTimeoutFn, clearTimeoutFn: vi.fn() as unknown as typeof clearTimeout });
    shell.prepare();

    shell.showAgentStreaming('run-1', [{ text: '', tools: [] }]);
    expect(snapshotsOf(send)).toEqual([]);

    shell.showAgentStreaming('run-1', step('Here'));
    shell.showAgentStreaming('run-1', step('Here is'));
    shell.showAgentStreaming('run-1', step('Here is what I found.'));
    expect(snapshotsOf(send).map((snapshot) => snapshot.steps)).toEqual([step('Here')]);

    // The trailing publish sends only the latest text; an unchanged one is deduped.
    timers.shift()?.();
    timers.shift()?.();
    const snapshots = snapshotsOf(send);
    expect(snapshots.map((snapshot) => snapshot.steps)).toEqual([step('Here'), step('Here is what I found.')]);
    expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([1, 2]);
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: false });
  });

  it('ranks a pending approval above status and falls back to the surviving stream after expiry', async () => {
    const timers: Array<{ fn: () => void; delay: number }> = [];
    const setTimeoutFn = vi.fn((fn: () => void, delay: number) => {
      timers.push({ fn, delay });
      return timers.length - 1;
    }) as unknown as typeof setTimeout;
    const { send, window } = createWindowMock();
    electronMock.BrowserWindow.mockImplementation(() => window);
    const shell = await createShell('agent-approval-priority', { setTimeoutFn, clearTimeoutFn: vi.fn() as unknown as typeof clearTimeout });
    shell.prepare();

    shell.showAgentStreaming('run-1', step('Draft ready for review'));
    shell.showAgentApproval({
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      serverId: 'mail',
      serverDisplayName: 'Gmail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: { to: 'a@example.com' },
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    });

    const snapshots = snapshotsOf(send);
    expect(snapshots.at(-1)).toMatchObject({ kind: 'agent-approval', approvalId: 'approval-1' });

    const expiryTimer = timers.at(-1);
    expect(expiryTimer?.delay).toBeLessThanOrEqual(30000);
    expect(expiryTimer?.delay).toBeGreaterThan(29000);
    expiryTimer?.fn();

    expect(snapshotsOf(send).at(-1)).toMatchObject({ kind: 'agent-streaming', steps: step('Draft ready for review') });
  });

  it('replaces the expiry timer when the same approval is rescheduled', async () => {
    const timers: Array<{ fn: () => void; delay: number }> = [];
    const setTimeoutFn = vi.fn((fn: () => void, delay: number) => {
      timers.push({ fn, delay });
      return timers.length;
    }) as unknown as typeof setTimeout;
    const clearTimeoutFn = vi.fn() as unknown as typeof clearTimeout;
    const { send, window } = createWindowMock();
    electronMock.BrowserWindow.mockImplementation(() => window);
    const shell = await createShell('approval-rescheduled', { setTimeoutFn, clearTimeoutFn });
    shell.prepare();
    shell.showAgentStreaming('run-1', step('Draft ready for review'));

    const firstExpiry = new Date(Date.now() + 30000).toISOString();
    shell.showAgentApproval({
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      serverId: 'mail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: {},
      expiresAt: firstExpiry,
    });
    const firstTimer = timers[1]; // timers[0] is the stream publish timer.

    const secondExpiry = new Date(Date.now() + 60000).toISOString();
    shell.showAgentApproval({
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      serverId: 'mail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: {},
      expiresAt: secondExpiry,
    });

    expect(clearTimeoutFn).toHaveBeenCalledWith(2);
    firstTimer.fn();
    expect(snapshotsOf(send).at(-1)).toMatchObject({
      kind: 'agent-approval',
      approvalId: 'approval-1',
      expiresAt: secondExpiry,
    });

    shell.clearAgentRun();
    expect(clearTimeoutFn).toHaveBeenCalledWith(3);
    expect(snapshotsOf(send).at(-1)).toMatchObject({ kind: 'idle' });
  });

  it('ignores approvals with invalid expiry timestamps', async () => {
    const setTimeoutFn = vi.fn() as unknown as typeof setTimeout;
    const { send, window } = createWindowMock();
    electronMock.BrowserWindow.mockImplementation(() => window);
    const shell = await createShell('invalid-approval-expiry', {
      setTimeoutFn,
      clearTimeoutFn: vi.fn() as unknown as typeof clearTimeout,
    });
    shell.prepare();

    shell.showAgentApproval({
      agentRunId: 'run-1',
      approvalId: 'approval-invalid',
      serverId: 'mail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: {},
      expiresAt: 'not-a-date',
    });

    expect(snapshotsOf(send)).toEqual([]);
    expect(setTimeoutFn).not.toHaveBeenCalled();
  });

  it('presents the approval card interactable and keyboard-capable without stealing focus', async () => {
    const { window: win } = createWindowMock();
    electronMock.BrowserWindow.mockImplementation(() => win);
    const shell = await createShell('approval-policy');
    shell.prepare();

    shell.showAgentApproval({
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      serverId: 'mail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: {},
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    });

    // Focusable so a deliberate click can type denial feedback, but shown
    // inactive; pointer input enabled for the controls.
    expect(win.setFocusable).toHaveBeenLastCalledWith(true);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: false });
    expect(win.showInactive).toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
  });

  it('grows streamed and completed cards toward measured content within the clamp', async () => {
    const { window: win } = createWindowMock();
    electronMock.BrowserWindow.mockImplementation(() => win);
    const shell = await createShell('card-growth');
    shell.prepare();

    shell.showAgentCompleted('run-1', 'Long answer', [], []);
    win.setBounds.mockClear();

    shell.handleAgentCardSize(Number.NaN);
    shell.handleAgentCardSize(Number.POSITIVE_INFINITY);
    expect(win.setBounds).not.toHaveBeenCalled();

    // Renderer reports the natural content height (chrome included).
    shell.handleAgentCardSize(460);

    const boundsCalls = ((win.setBounds as ReturnType<typeof vi.fn>).mock.calls as unknown[][])
      .map((call) => call[0] as { width: number; height: number });
    expect(boundsCalls.at(-1)).toMatchObject({ width: 520, height: 460 });

    // Content beyond the clamp stops growing; the body scrolls instead.
    shell.handleAgentCardSize(900);
    expect(((win.setBounds as ReturnType<typeof vi.fn>).mock.calls as unknown[][]).at(-1)?.[0]).toMatchObject({ width: 520, height: 520 });
  });

  it('offers a reply only while the answer is the visible card', async () => {
    const { window } = createWindowMock();
    electronMock.BrowserWindow.mockImplementation(() => window);
    const shell = await createShell('reply-visible-answer');
    shell.prepare();

    shell.showAgentCompleted('run-1', 'Answer', [], []);
    expect(shell.getPresentedCompletedRunId()).toBe('run-1');
    shell.showFailure('session-1', 'Paste failed');
    expect(shell.getPresentedCompletedRunId()).toBeNull();
  });

  it('shows a reply under the exchange it answers, and a new run on its own', async () => {
    const { send, window } = createWindowMock();
    electronMock.BrowserWindow.mockImplementation(() => window);
    const shell = await createShell('reply-thread');
    shell.prepare();

    shell.startAgentTurn('run-1', 'Weather?');
    shell.showAgentCompleted('run-1', 'Which city?', [], []);
    // The reply is recorded first, which takes the answered card down.
    shell.show('agent');
    shell.startAgentTurn('run-1', 'Pune.');
    shell.showAgentStatus('run-1', 'Thinking…');
    expect(snapshotsOf(send).at(-1)).toMatchObject({
      kind: 'agent-status',
      thread: { turns: [{ command: 'Weather?', response: 'Which city?' }], command: 'Pune.' },
    });

    shell.showAgentCompleted('run-1', 'Sunny.', [], []);
    shell.show('agent');
    shell.startAgentTurn('run-2', 'Joke?');
    shell.showAgentStatus('run-2', 'Thinking…');
    expect(snapshotsOf(send).at(-1)).toMatchObject({ kind: 'agent-status', thread: { turns: [], command: 'Joke?' } });
  });

  it('ignores Agent card sizes while another presentation is visible', async () => {
    const { window } = createWindowMock();
    electronMock.BrowserWindow.mockImplementation(() => window);
    const shell = await createShell('card-size-visible-state');
    shell.prepare();

    shell.showAgentStreaming('run-1', step('Long answer'));
    shell.showFailure('session-1', 'Paste failed');
    window.setBounds.mockClear();

    shell.handleAgentCardSize(460);

    expect(window.setBounds).not.toHaveBeenCalled();
    shell.finish();
    shell.handleAgentCardSize(460);
    expect(window.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 520, height: 460 }),
      false,
    );
  });

  it('retires a pending approval once post-decision run activity arrives', async () => {
    const { send, window } = createWindowMock();
    electronMock.BrowserWindow.mockImplementation(() => window);
    const shell = await createShell('approval-resolved');
    shell.prepare();

    shell.showAgentApproval({
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      serverId: 'mail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: {},
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    });

    // The sidecar blocks while awaiting the decision, so any later event
    // proves the user (or expiry) resolved it.
    shell.showAgentStatus('run-1', 'Using tools: mail.send_message');

    expect(snapshotsOf(send).at(-1)).toMatchObject({ kind: 'agent-status' });
    expect(snapshotsOf(send).filter((snapshot) => snapshot.kind === 'agent-approval')).toHaveLength(1);
  });

  it('lets a dictation recording preempt an approval visually and restores it after capture finishes', async () => {
    const { send, window: win } = createWindowMock();
    electronMock.BrowserWindow.mockImplementation(() => win);
    const shell = await createShell('dictation-preempts-approval');
    shell.prepare();
    shell.markReady();
    shell.beginCapture({
      recordingSessionId: 'session-2', sequence: 1, revision: 1,
      capabilities: { batch: true as const, streaming: false },
    });
    shell.showAgentApproval({
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      serverId: 'mail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: {},
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    });
    const envelope = {
      recordingSessionId: 'session-2', sequence: 1, revision: 1,
      capabilities: { batch: true as const, streaming: false },
    };
    shell.show('dictation', 'session-2', envelope);
    expect(snapshotsOf(send).at(-1)).toMatchObject({ kind: 'recording', intent: 'dictation' });

    shell.finish();

    expect(snapshotsOf(send).at(-1)).toMatchObject({ kind: 'agent-approval', approvalId: 'approval-1' });
    expect(win.hide).not.toHaveBeenCalled();
  });

  it('keeps Dictation processing and failure ahead of a pending Agent approval', async () => {
    const { send, window } = createWindowMock();
    electronMock.BrowserWindow.mockImplementation(() => window);
    const shell = await createShell('dictation-terminal-precedence');
    shell.prepare();

    shell.showAgentApproval({
      agentRunId: 'run-1',
      approvalId: 'approval-1',
      serverId: 'mail',
      toolName: 'send_message',
      modelToolName: 'mail__send_message',
      arguments: {},
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    });

    shell.showProcessing('session-1');
    expect(snapshotsOf(send).at(-1)).toMatchObject({
      kind: 'processing',
      recordingSessionId: 'session-1',
    });
    shell.finish();
    expect(snapshotsOf(send).at(-1)).toMatchObject({
      kind: 'agent-approval',
      approvalId: 'approval-1',
    });

    shell.showFailure('session-1', 'Paste failed', ['retry-paste']);
    expect(snapshotsOf(send).at(-1)).toMatchObject({
      kind: 'failure',
      recordingSessionId: 'session-1',
      message: 'Paste failed',
    });
    shell.finish();
    expect(snapshotsOf(send).at(-1)).toMatchObject({
      kind: 'agent-approval',
      approvalId: 'approval-1',
    });
  });

  it('invalidates prior run presentation when an agent recording starts but not when dictation starts', async () => {
    const { send, window: win } = createWindowMock();
    electronMock.BrowserWindow.mockImplementation(() => win);
    const shell = await createShell('run-invalidation');
    shell.prepare();
    shell.markReady();
    const envelope = {
      recordingSessionId: 'session-a', sequence: 1, revision: 1,
      capabilities: { batch: true as const, streaming: false },
    };

    // Surviving stream from a finished run.
    shell.showAgentCompleted('run-old', 'Previous answer', [], []);
    shell.beginCapture(envelope);
    shell.show('dictation', 'session-a', envelope);
    shell.finish();
    expect(snapshotsOf(send).at(-1)).toMatchObject({ kind: 'agent-completed' });

    // A new Agent recording invalidates it: nothing resurfaces afterwards.
    const nextEnvelope = {
      recordingSessionId: 'session-b', sequence: 1, revision: 1,
      capabilities: { batch: true as const, streaming: false },
    };
    shell.beginCapture(nextEnvelope);
    shell.show('agent', 'session-b', nextEnvelope);
    shell.finish();
    expect(snapshotsOf(send).at(-1)).toMatchObject({ kind: 'idle' });
  });

  it('replays surviving Agent presentation after a renderer crash', async () => {
    function createCrashWindow() {
      const webHandlers = new Map<string, (...args: unknown[]) => void>();
      return {
        webHandlers,
        webContents: {
          send: vi.fn(),
          isLoading: vi.fn(() => true),
          setWindowOpenHandler: vi.fn(),
          on: vi.fn((event: string, handler: (...args: unknown[]) => void) => webHandlers.set(event, handler)),
        },
        loadURL: vi.fn(), loadFile: vi.fn(), on: vi.fn(), once: vi.fn(),
        isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => false),
        setPosition: vi.fn(), setAlwaysOnTop: vi.fn(), showInactive: vi.fn(),
        hide: vi.fn(), destroy: vi.fn(), setBounds: vi.fn(),
        setFocusable: vi.fn(), setIgnoreMouseEvents: vi.fn(),
      };
    }

    const windows: ReturnType<typeof createCrashWindow>[] = [];
    electronMock.BrowserWindow.mockImplementation(() => {
      const window = createCrashWindow();
      windows.push(window);
      return window;
    });
    const shell = await createShell('agent-crash-replay');
    shell.prepare();
    shell.showAgentCompleted('run-1', 'Recovered answer', [], []);

    windows[0].webHandlers.get('render-process-gone')?.({}, { reason: 'crashed' });
    windows[1].webHandlers.get('did-finish-load')?.();

    expect(windows[1].webContents.send).toHaveBeenCalledWith(
      'runtime:snapshot',
      expect.objectContaining({
        kind: 'agent-completed',
        agentRunId: 'run-1',
        response: 'Recovered answer',
        generation: 2,
        revision: 1,
      }),
    );
  });

  it('clears cancelled runs silently without flashing a cancelled card', async () => {
    const { send, window } = createWindowMock();
    electronMock.BrowserWindow.mockImplementation(() => window);
    const shell = await createShell('cancelled-silent');
    shell.prepare();

    shell.showAgentStatus('run-1', 'Checking mail');
    shell.clearAgentRun();

    const kinds = snapshotsOf(send).map((snapshot) => snapshot.kind);
    expect(kinds).toEqual(['agent-status', 'idle']);
  });
});

