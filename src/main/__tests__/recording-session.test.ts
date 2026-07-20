import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { RecordingActivationMode, RecordingIntent } from '../../types/ipc';
import type { Transcriber } from '../transcription';
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
  updateRecordingDurationWarning: vi.fn(),
}));

function createTranscriber(transcribe: Transcriber['transcribe']): Transcriber {
  return {
    id: 'local-whisper-cpp',
    capabilities: {
      translation: true,
      automaticLanguageDetection: true,
      dictionaryHints: true,
      authentication: 'none',
      maxDurationSeconds: null,
    },
    transcribe,
  };
}

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
  let getRecordingActivationMode: ReturnType<typeof vi.fn>;
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
    getRecordingActivationMode = vi.fn(() => 'toggle' satisfies RecordingActivationMode);
    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      transcriber: createTranscriber(({ audio }) => transcribe(audio)),
      keyboardHook: {
        start: keyboardStart,
        stop: keyboardStop,
      },
      captureTarget,
      isAgentModeEnabled,
      getRecordingActivationMode,
    });
  });

  it('prepares the audio stream and begins capture when recording starts', () => {
    session.begin('dictation');

    expect(audioStream.prepare).toHaveBeenCalledTimes(1);
    expect(audioStream.beginCapture).toHaveBeenCalledTimes(1);
    expect(showRecordingPill).toHaveBeenCalledWith('dictation');
    expect(session.isActive()).toBe(true);
  });

  it('prevents keyboard-triggered recording when the active provider is not ready', () => {
    const readinessError = new Error('OpenAI model is not configured.');
    const onError = vi.fn();
    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      transcriber: createTranscriber(({ audio }) => transcribe(audio)),
      getReadinessError: () => readinessError,
      onError,
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
    });

    session.start();
    const onKeyboardStart = keyboardStart.mock.calls[0]?.[0] as (intent: RecordingIntent) => void;
    onKeyboardStart('agent');

    expect(onError).toHaveBeenCalledWith(readinessError);
    expect(audioStream.beginCapture).not.toHaveBeenCalled();
    expect(showRecordingPill).not.toHaveBeenCalled();
    expect(session.isActive()).toBe(false);
  });

  it('submits completed audio and recognition settings through the provider-neutral transcriber', async () => {
    const providerTranscriber: Transcriber = {
      id: 'local-whisper-cpp',
      capabilities: {
        translation: true,
        automaticLanguageDetection: true,
        dictionaryHints: true,
        authentication: 'none',
        maxDurationSeconds: null,
      },
      transcribe: vi.fn(async () => 'provider text'),
    };
    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      transcriber: providerTranscriber,
      getRecognitionSettings: () => ({
        language: 'mr',
        task: 'translate',
        dictionary: ['Shuddhalekhan'],
        removeFillerWords: true,
      }),
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
    });

    session.begin('dictation');
    const resultPromise = session.end();
    const audio = new Uint8Array(64).fill(7);
    await session.complete(audio);

    await expect(resultPromise).resolves.toMatchObject({ text: 'provider text', intent: 'dictation' });
    expect(providerTranscriber.transcribe).toHaveBeenCalledWith({
      audio: expect.any(Uint8Array),
      recognition: {
        language: 'mr',
        task: 'translate',
        dictionary: ['Shuddhalekhan'],
        removeFillerWords: true,
      },
    });
    expect(audio.every((byte) => byte === 0)).toBe(true);
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
    const [onStart, onStop, enabled, getActivationMode] = keyboardStart.mock.calls[0] as [
      (intent: RecordingIntent) => void,
      () => void,
      () => boolean,
      () => RecordingActivationMode,
    ];

    expect(enabled()).toBe(false);
    expect(getActivationMode()).toBe('toggle');
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
      transcriber: createTranscriber(({ audio }) => transcribe(audio)),
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
      transcriber: createTranscriber(({ audio }) => failingTranscribe(audio)),
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
    
    const fakeAudioData = new Uint8Array(64).fill(9);
    await listener({}, fakeAudioData.buffer);

    await expect(endPromise).rejects.toThrow('Whisper offline');
    expect(fakeAudioData.every((byte) => byte === 0)).toBe(true);
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('warns for the final ten seconds and auto-stops a duration-limited provider exactly once', async () => {
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    const updateDurationWarning = vi.fn();
    const recordingEndedExternally = vi.fn();
    const limitedTranscriber: Transcriber = {
      ...createTranscriber(async () => 'limited result'),
      id: 'google-cloud-speech-v2',
      capabilities: {
        translation: false,
        automaticLanguageDetection: false,
        dictionaryHints: true,
        authentication: 'required',
        maxDurationSeconds: 55,
      },
    };
    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      updateDurationWarning,
      transcriber: limitedTranscriber,
      setTimeoutFn: ((callback: () => void, delay: number) => {
        timers.push({ callback, delay, cleared: false });
        return timers.length - 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutFn: ((id: number) => { if (timers[id]) timers[id].cleared = true; }) as typeof clearTimeout,
      keyboardHook: { start: keyboardStart, stop: keyboardStop, recordingEndedExternally },
      captureTarget,
      isAgentModeEnabled,
      getRecordingActivationMode,
    });

    session.begin('dictation');
    expect(timers.map((timer) => timer.delay)).toEqual([
      45000, 46000, 47000, 48000, 49000, 50000, 51000, 52000, 53000, 54000, 55000,
    ]);
    timers.find((timer) => timer.delay === 45000)?.callback();
    expect(updateDurationWarning).toHaveBeenCalledWith(10);
    timers.find((timer) => timer.delay === 54000)?.callback();
    expect(updateDurationWarning).toHaveBeenCalledWith(1);
    timers.find((timer) => timer.delay === 55000)?.callback();
    timers.find((timer) => timer.delay === 55000)?.callback();

    expect(audioStream.endCapture).toHaveBeenCalledTimes(1);
    expect(recordingEndedExternally).toHaveBeenCalledTimes(1);
    expect(hideRecordingPill).toHaveBeenCalledTimes(1);
    expect(session.isActive()).toBe(false);
    session.begin('agent');
    expect(audioStream.beginCapture).toHaveBeenCalledTimes(1);
  });

  it('does not double-invoke onResult when triggered via keyboard hook', async () => {
    const onResult = vi.fn();
    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      transcriber: createTranscriber(({ audio }) => transcribe(audio)),
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
