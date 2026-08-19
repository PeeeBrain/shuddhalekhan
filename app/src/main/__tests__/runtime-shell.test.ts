import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

const vi = { fn: mock };

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
    expect(send).not.toHaveBeenCalledWith('audio:start-recording');
  });

  it('publishes complete monotonic recording, processing, failure, and idle snapshots', async () => {
    const send = vi.fn();
    const window = {
      webContents: { send, on: vi.fn(), isLoading: vi.fn(() => false) },
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

    const envelope = {
      recordingSessionId: 'session-1', sequence: 1, revision: 1,
      capabilities: { batch: true as const, streaming: false },
    };
    shell.beginCapture(envelope);
    shell.show('dictation', 'session-1', envelope);
    shell.showProcessing('session-1');
    shell.showFailure('session-1', 'Paste failed', ['retry-paste', 'copy-full-transcript']);
    shell.finish();

    const snapshots = (send.mock.calls as unknown[][])
      .filter((call: unknown[]) => call[0] === 'runtime:snapshot')
      .map((call: unknown[]) => call[1] as { kind: string; revision: number });
    expect(snapshots.map((snapshot: { kind: string }) => snapshot.kind)).toEqual([
      'recording', 'processing', 'failure', 'idle',
    ]);
    expect(snapshots.map((snapshot: { revision: number }) => snapshot.revision)).toEqual([1, 2, 3, 4]);
    expect(send).toHaveBeenCalledWith('runtime:audio-start', expect.objectContaining({
      recordingSessionId: 'session-1', sequence: 1,
    }));
    expect(send).toHaveBeenCalledWith('recording:pill-hide');
    expect(window.setFocusable).toHaveBeenCalledWith(true);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(false, { forward: false });
    const command = (send.mock.calls as unknown[][]).find((call: unknown[]) => call[0] === 'runtime:audio-start')?.[1] as { generation: number };
    expect(shell.acceptsAudioEvent(command.generation, 'session-1', 1)).toBe(false);
  });

  it('does not let a pending idle hide dismiss a newer failure', async () => {
    const scheduled = new Map<number, () => void>();
    let nextTimer = 1;
    const setTimeoutFn = vi.fn((callback: () => void) => {
      const timer = nextTimer++;
      scheduled.set(timer, callback);
      return timer as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutFn = vi.fn((timer: ReturnType<typeof setTimeout>) => {
      scheduled.delete(timer as unknown as number);
    });
    const window = {
      webContents: { send: vi.fn(), on: vi.fn(), isLoading: vi.fn(() => false) },
      loadURL: vi.fn(), loadFile: vi.fn(), on: vi.fn(), once: vi.fn(),
      isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => true),
      setPosition: vi.fn(), setAlwaysOnTop: vi.fn(), showInactive: vi.fn(),
      setBounds: vi.fn(), setFocusable: vi.fn(), setIgnoreMouseEvents: vi.fn(),
      hide: vi.fn(), destroy: vi.fn(),
    };
    electronMock.BrowserWindow.mockImplementation(() => window);
    const { RuntimeShell } = await import(`../runtime-shell?test=${Date.now()}-hide-race`);
    const shell = new RuntimeShell(undefined, { setTimeoutFn, clearTimeoutFn });
    shell.prepare();

    shell.finish();
    shell.showFailure('session-1', 'Paste failed', ['retry-paste']);
    for (const callback of scheduled.values()) callback();

    expect(clearTimeoutFn).toHaveBeenCalledTimes(1);
    expect(window.hide).not.toHaveBeenCalled();
  });

  it('accepts returned audio only for the current generation, session, and sequence', async () => {
    const send = vi.fn();
    const window = {
      webContents: { send, on: vi.fn(), isLoading: vi.fn(() => false) },
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
  });

  it('recreates a crashed renderer in a new generation and publishes one recoverable failure', async () => {
    const onCrash = vi.fn();
    const windows: any[] = [];
    electronMock.BrowserWindow.mockImplementation(() => {
      const handlers = new Map<string, (...args: any[]) => void>();
      const webHandlers = new Map<string, (...args: any[]) => void>();
      const window = {
        handlers, webHandlers,
        webContents: {
          send: vi.fn(), isLoading: vi.fn(() => true),
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
    const shell = new RuntimeShell(onCrash);
    shell.prepare();
    shell.markReady();
    shell.beginCapture({
      recordingSessionId: 'doomed', sequence: 1, revision: 1,
      capabilities: { batch: true, streaming: false },
    });
    const oldCommand = (windows[0].webContents.send.mock.calls as unknown[][])
      .find((call) => call[0] === 'runtime:audio-start')?.[1] as any;

    windows[0].webHandlers.get('render-process-gone')?.({}, { reason: 'crashed' });
    expect(windows).toHaveLength(2);
    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(shell.acceptsAudioEvent(oldCommand.generation, 'doomed', 1)).toBe(false);

    shell.showFailure('doomed', 'Recording renderer crashed.');
    windows[1].webHandlers.get('did-finish-load')?.();
    expect(windows[1].webContents.send).toHaveBeenCalledWith(
      'runtime:snapshot',
      expect.objectContaining({ kind: 'failure', generation: oldCommand.generation + 1, revision: 1 }),
    );
  });
});
