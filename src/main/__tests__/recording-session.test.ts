import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { RecordingIntent } from '../../types/ipc';
import { installElectronMock, resetElectronMock, electronMock } from '../../test/electron-mock';
import type { RecordingSession, AudioCapture } from '../recording-session';

const vi = { fn: mock };
let RecordingSessionCtor: typeof RecordingSession;

installElectronMock();
mock.module('../native/keyboard', () => ({
  keyboardHook: { start: vi.fn(), stop: vi.fn() },
}));
const getRecordingPillWindowMock = vi.fn();
mock.module('../recording-pill', () => ({
  showRecordingPill: vi.fn(),
  hideRecordingPill: vi.fn(),
  getRecordingPillWindow: getRecordingPillWindowMock,
}));

function createAudioCaptureMock(): AudioCapture & {
  [K in keyof AudioCapture]: ReturnType<typeof vi.fn>;
} {
  return {
    prepare: vi.fn(),
    beginCapture: vi.fn(),
    endCapture: vi.fn(),
    cancelCapture: vi.fn(),
    setSelectedDevice: vi.fn(),
    destroy: vi.fn(),
    markReady: vi.fn(),
    markCrashed: vi.fn(),
    getWebContents: vi.fn(),
  };
}

describe('RecordingSession', () => {
  let audioStream: ReturnType<typeof createAudioCaptureMock>;
  let showRecordingPill: ReturnType<typeof vi.fn>;
  let hideRecordingPill: ReturnType<typeof vi.fn>;
  let transcribe: ReturnType<typeof vi.fn>;
  let keyboardStart: ReturnType<typeof vi.fn>;
  let keyboardStop: ReturnType<typeof vi.fn>;
  let captureTarget: ReturnType<typeof vi.fn>;
  let isAgentModeEnabled: ReturnType<typeof vi.fn>;
  let session: RecordingSession;

  afterAll(() => {
    mock.restore();
  });

  beforeEach(async () => {
    resetElectronMock();
    ({ RecordingSession: RecordingSessionCtor } = await import(`../recording-session?test=${Date.now()}-${Math.random()}`));
    audioStream = createAudioCaptureMock();
    showRecordingPill = vi.fn();
    hideRecordingPill = vi.fn();
    transcribe = vi.fn(async () => 'transcribed text');
    keyboardStart = vi.fn();
    keyboardStop = vi.fn();
    captureTarget = vi.fn(() => ({
      hwnd: 12345,
      processId: 67890,
      threadId: 111,
      windowClass: 'Notepad',
      executablePath: 'C:\\Windows\\notepad.exe',
      capturedAt: new Date().toISOString(),
    }));
    isAgentModeEnabled = vi.fn(() => false);
    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      whisperClient: transcribe,
      keyboardHook: {
        start: keyboardStart,
        stop: keyboardStop,
      },
      captureTarget,
      isAgentModeEnabled,
    });
  });

  it('prepares the audio stream and begins capture when recording starts', () => {
    session.begin('dictation');

    expect(audioStream.prepare).toHaveBeenCalledTimes(1);
    expect(audioStream.beginCapture).toHaveBeenCalledTimes(1);
    expect(showRecordingPill).toHaveBeenCalledWith('dictation');
    expect(session.isActive()).toBe(true);
  });

  it('ends recording and resolves with transcribed text and original intent', async () => {
    session.begin('agent');

    const resultPromise = session.end();
    await session.complete(new Uint8Array(64));

    await expect(resultPromise).resolves.toEqual({
      text: 'transcribed text',
      intent: 'agent' satisfies RecordingIntent,
      targetSnapshot: expect.any(Object),
    });
    expect(hideRecordingPill).toHaveBeenCalled();
    expect(audioStream.endCapture).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith(new Uint8Array(64));
    expect(session.isActive()).toBe(false);
  });

  it('captures the foreground target when recording begins and returns it with the result', async () => {
    const snapshot = {
      hwnd: 42,
      processId: 100,
      threadId: 200,
      windowClass: 'Chrome_WidgetWin_1',
      executablePath: 'C:\\Program Files\\Chrome\\chrome.exe',
      capturedAt: new Date().toISOString(),
    };
    captureTarget.mockReturnValue(snapshot);

    session.begin('dictation');

    expect(captureTarget).toHaveBeenCalledTimes(1);

    const resultPromise = session.end();
    await session.complete(new Uint8Array(64));

    await expect(resultPromise).resolves.toMatchObject({ targetSnapshot: snapshot });
  });

  it('resolves empty WAV payloads to null without transcription', async () => {
    session.begin('dictation');

    const resultPromise = session.end();
    await session.complete(new Uint8Array(44));

    await expect(resultPromise).resolves.toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('cancels recording and tells the audio stream to discard capture', async () => {
    session.begin('dictation');

    await expect(session.cancel()).resolves.toBeUndefined();

    expect(hideRecordingPill).toHaveBeenCalled();
    expect(audioStream.cancelCapture).toHaveBeenCalledTimes(1);
    expect(session.isActive()).toBe(false);
  });

  it('delegates audio window readiness to the audio stream', () => {
    session.markAudioWindowReady();
    expect(audioStream.markReady).toHaveBeenCalledTimes(1);
  });

  it('delegates audio window crash recovery to the audio stream', () => {
    session.markAudioWindowCrashed('render-process-gone');
    expect(audioStream.markCrashed).toHaveBeenCalledWith('render-process-gone');
  });

  it('owns keyboard hook lifecycle', () => {
    const onResult = vi.fn();

    session.startKeyboardHook(onResult);
    const [onStart, onStop, enabled] = keyboardStart.mock.calls[0] as [
      (intent: RecordingIntent) => void,
      () => void,
      () => boolean,
    ];

    expect(enabled()).toBe(false);
    onStart('agent');
    expect(audioStream.beginCapture).toHaveBeenCalledTimes(1);
    onStop();
    session.stopKeyboardHook();

    expect(keyboardStop).toHaveBeenCalledTimes(1);
  });

  it('registers IPC listeners on start() and unregisters them on stop()', () => {
    session.start();

    const registeredChannels = (electronMock.ipcMain.on as any).mock.calls.map((call: any) => call[0]);
    expect(registeredChannels).toContain('audio-window-ready');
    expect(registeredChannels).toContain('audio-stream-ready');
    expect(registeredChannels).toContain('audio-data-ready');
    expect(registeredChannels).toContain('audio-level-changed');

    session.stop();

    const unregisteredChannels = (electronMock.ipcMain.off as any).mock.calls.map((call: any) => call[0]);
    expect(unregisteredChannels).toContain('audio-window-ready');
    expect(unregisteredChannels).toContain('audio-stream-ready');
    expect(unregisteredChannels).toContain('audio-data-ready');
    expect(unregisteredChannels).toContain('audio-level-changed');
  });

  it('forwards audio-level-changed event to the recording pill window', () => {
    const mockPillWin = {
      isDestroyed: vi.fn(() => false),
      webContents: {
        send: vi.fn(),
      },
    };
    getRecordingPillWindowMock.mockReturnValue(mockPillWin);

    session.start();

    const audioLevelCall = (electronMock.ipcMain.on as any).mock.calls.find(
      (call: any) => call[0] === 'audio-level-changed'
    );
    expect(audioLevelCall).toBeDefined();
    const listener = audioLevelCall[1];

    listener({}, 0.5);

    expect(mockPillWin.webContents.send).toHaveBeenCalledWith('audio:level-changed', 0.5);
  });

  it('calls onResult when audio-data-ready is triggered and transcription succeeds', async () => {
    const onResult = vi.fn();
    const onError = vi.fn();
    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      whisperClient: transcribe,
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      onResult,
      onError,
    });

    session.start();
    session.begin('dictation');

    const audioDataReadyCall = (electronMock.ipcMain.on as any).mock.calls.find(
      (call: any) => call[0] === 'audio-data-ready'
    );
    expect(audioDataReadyCall).toBeDefined();
    const listener = audioDataReadyCall[1];

    const endPromise = session.end();
    
    const fakeAudioData = new Uint8Array(64);
    await listener({}, fakeAudioData.buffer);

    await endPromise;
    expect(onResult).toHaveBeenCalledWith({
      text: 'transcribed text',
      intent: 'dictation',
      targetSnapshot: expect.any(Object),
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('calls onError when transcription fails', async () => {
    const onResult = vi.fn();
    const onError = vi.fn();
    const failingTranscribe = vi.fn(() => Promise.reject(new Error('Whisper offline')));

    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      whisperClient: failingTranscribe,
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      onResult,
      onError,
    });

    session.start();
    session.begin('dictation');

    const audioDataReadyCall = (electronMock.ipcMain.on as any).mock.calls.find(
      (call: any) => call[0] === 'audio-data-ready'
    );
    const listener = audioDataReadyCall[1];

    const endPromise = session.end();
    
    const fakeAudioData = new Uint8Array(64);
    await listener({}, fakeAudioData.buffer);

    await expect(endPromise).rejects.toThrow('Whisper offline');
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('does not double-invoke onResult when triggered via keyboard hook', async () => {
    const onResult = vi.fn();
    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      whisperClient: transcribe,
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      onResult,
    });

    session.start();
    session.begin('dictation');

    // Trigger keyboard-stop callback
    const onStop = keyboardStart.mock.calls[0][1] as () => void;
    onStop();

    // Trigger audio-data-ready
    const audioDataReadyCall = (electronMock.ipcMain.on as any).mock.calls.find(
      (call: any) => call[0] === 'audio-data-ready'
    );
    const listener = audioDataReadyCall[1];
    
    const fakeAudioData = new Uint8Array(64);
    await listener({}, fakeAudioData.buffer);

    // Wait a brief moment
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onResult).toHaveBeenCalledTimes(1);
  });
});
