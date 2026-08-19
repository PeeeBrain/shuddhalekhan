import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { RecordingActivationMode, RecordingIntent } from '../../types/ipc';
import type { StreamingTranscriptionRequest, Transcriber } from '../transcription';
import { installElectronMock, resetElectronMock, electronMock } from '../../test/electron-mock';
import type { RecordingSession, AudioCapture } from '../recording-session';
import {
  createMarkerCollector,
  resetPerformanceMarkerCollectorForTests,
  setPerformanceMarkerCollector,
} from '../performance/marker-collector';

const vi = { fn: mock };
let RecordingSessionCtor: typeof RecordingSession;

installElectronMock();
mock.module('../native/keyboard', () => ({
  keyboardHook: { start: vi.fn(), stop: vi.fn() },
}));
const getRecordingPillWindowMock = vi.fn();
const prepareRecordingPillWindowMock = vi.fn();
mock.module('../recording-pill', () => ({
  showRecordingPill: vi.fn(),
  hideRecordingPill: vi.fn(),
  getRecordingPillWindow: getRecordingPillWindowMock,
  prepareRecordingPillWindow: prepareRecordingPillWindowMock,
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
    prepareRecordingPillWindowMock.mockClear();
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
    expect(showRecordingPill).toHaveBeenCalledWith(
      'dictation',
      expect.any(String),
      expect.objectContaining({
        sequence: 1,
        revision: 1,
        capabilities: { batch: true, streaming: false },
      }),
    );
    expect(session.isActive()).toBe(true);
  });

  it('attaches opaque session identity, revision, and provider capabilities to recording presentation', () => {
    session.begin('dictation');

    expect(showRecordingPill).toHaveBeenCalledWith(
      'dictation',
      expect.any(String),
      expect.objectContaining({
        recordingSessionId: expect.any(String),
        sequence: 1,
        revision: 1,
        capabilities: { batch: true, streaming: false },
      }),
    );
    const envelope = showRecordingPill.mock.calls[0]?.[2] as { recordingSessionId: string };
    expect(showRecordingPill.mock.calls[0]?.[1]).toBe(envelope.recordingSessionId);
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
    const options = keyboardStart.mock.calls[0]?.[0] as {
      onStart: (intent: RecordingIntent) => void;
    };
    options.onStart('agent');

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
      recordingSessionId: expect.any(String),
      sequence: 2,
      revision: 2,
      capabilities: { batch: true, streaming: false },
      outcome: { kind: 'completed' },
    });
    expect(hideRecordingPill).toHaveBeenCalled();
    expect(audioStream.endCapture).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith(new Uint8Array(64));
    expect(session.isActive()).toBe(false);
  });

  it('pins the transcriber and advances session metadata monotonically through completion', async () => {
    const firstTranscribe = vi.fn(async () => 'first provider');
    const secondTranscribe = vi.fn(async () => 'second provider');
    const firstTranscriber: Transcriber = {
      ...createTranscriber(firstTranscribe),
      transportCapabilities: { batch: true, streaming: true },
    };
    const secondTranscriber = createTranscriber(secondTranscribe);
    const getTranscriber = vi.fn()
      .mockReturnValueOnce(firstTranscriber)
      .mockReturnValue(secondTranscriber);
    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      getTranscriber,
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
    });

    session.begin('dictation', 'opaque-session');
    const resultPromise = session.end();
    await session.complete(new Uint8Array(64));

    expect(getTranscriber).toHaveBeenCalledTimes(1);
    expect(firstTranscribe).toHaveBeenCalledTimes(1);
    expect(secondTranscribe).not.toHaveBeenCalled();
    await expect(resultPromise).resolves.toMatchObject({
      text: 'first provider',
      recordingSessionId: 'opaque-session',
      sequence: 2,
      revision: 2,
      capabilities: { batch: true, streaming: true },
      outcome: { kind: 'completed' },
    });
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

  it('reports an empty WAV payload as a capture failure', async () => {
    const onError = vi.fn();
    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      transcriber: createTranscriber(({ audio }) => transcribe(audio)),
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      onError,
    });
    session.begin('dictation');

    const resultPromise = session.end();
    await session.complete(new Uint8Array(44));

    await expect(resultPromise).rejects.toThrow('No microphone audio was captured');
    expect(transcribe).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'No microphone audio was captured. Check the selected input device and try again.',
    }));
  });

  it('releases a session stopped before capture can start', async () => {
    audioStream.endCapture.mockReturnValue(false);
    session.begin('dictation', 'not-started');

    const resultPromise = session.end();
    const acceptedNext = session.begin('dictation', 'next-session');
    await session.cancel();

    await expect(resultPromise).resolves.toBeNull();
    expect(acceptedNext).toBe(true);
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

  it('clears recording state when delegating audio window crash recovery', () => {
    session.begin('dictation', 'crashed-session');
    session.markAudioWindowCrashed('render-process-gone');

    expect(audioStream.markCrashed).toHaveBeenCalledWith('render-process-gone');
    expect(hideRecordingPill).toHaveBeenCalled();
    expect(session.isActive()).toBe(false);

    session.begin('dictation', 'replacement-session');
    expect(showRecordingPill).toHaveBeenLastCalledWith(
      'dictation',
      'replacement-session',
      expect.objectContaining({
        recordingSessionId: 'replacement-session',
        sequence: 1,
        revision: 1,
      }),
    );
  });

  it('owns keyboard hook lifecycle', () => {
    const onResult = vi.fn();

    session.startKeyboardHook(onResult);
    const options = keyboardStart.mock.calls[0] as unknown as [
      {
        onStart: (intent: RecordingIntent) => void;
        onStop: () => void;
        isAgentModeEnabled: () => boolean;
        getBinding: (intent: RecordingIntent) => unknown;
        getActivationMode: (intent: RecordingIntent) => RecordingActivationMode;
      },
    ];
    const { onStart, onStop, isAgentModeEnabled: enabled, getBinding, getActivationMode } = options[0];

    expect(enabled()).toBe(false);
    expect(getActivationMode('dictation')).toBe('toggle');
    expect(getBinding('dictation')).toEqual({ keyCode: null, modifiers: ['ctrl', 'win'] });
    expect(getBinding('agent')).toEqual({ keyCode: null, modifiers: ['alt', 'win'] });
    onStart('agent');
    expect(audioStream.beginCapture).toHaveBeenCalledTimes(1);
    onStop();
    session.stopKeyboardHook();

    expect(keyboardStop).toHaveBeenCalledTimes(1);
  });

  it('passes configured per-intent bindings and activation modes to the keyboard hook', () => {
    const getShortcutBinding = vi.fn((intent: RecordingIntent) =>
      intent === 'dictation' ? { keyCode: 0x52, modifiers: [] } : null);
    const getMode = vi.fn((intent: RecordingIntent) =>
      (intent === 'dictation' ? 'toggle' : 'push-to-talk') as RecordingActivationMode);
    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      transcriber: createTranscriber(({ audio }) => transcribe(audio)),
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      getShortcutBinding,
      getRecordingActivationMode: getMode,
    });

    session.startKeyboardHook();
    const options = keyboardStart.mock.calls[0] as unknown as [
      {
        getBinding: (intent: RecordingIntent) => unknown;
        getActivationMode: (intent: RecordingIntent) => RecordingActivationMode;
      },
    ];

    expect(options[0].getBinding('dictation')).toEqual({ keyCode: 0x52, modifiers: [] });
    expect(options[0].getBinding('agent')).toBeNull();
    expect(options[0].getActivationMode('dictation')).toBe('toggle');
    expect(options[0].getActivationMode('agent')).toBe('push-to-talk');
  });

  it('prewarms the hidden recording pill renderer during startup', () => {
    session.start();

    expect(prepareRecordingPillWindowMock).toHaveBeenCalledTimes(1);
    expect(keyboardStart).toHaveBeenCalledTimes(1);
  });

  it('runs Batch capture, processing, and terminal presentation through the runtime shell', async () => {
    const runtimeShell = {
      prepare: vi.fn(),
      beginCapture: vi.fn(),
      endCapture: vi.fn(),
      cancelCapture: vi.fn(),
      setSelectedDevice: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      updateDurationWarning: vi.fn(),
      updateAudioLevel: vi.fn(),
      showProcessing: vi.fn(),
      showFailure: vi.fn(),
      finish: vi.fn(),
      destroy: vi.fn(),
      markReady: vi.fn(),
      markCrashed: vi.fn(),
      getWebContents: vi.fn(() => null),
      consumeAudioEvent: vi.fn(() => true),
    };
    session = new RecordingSessionCtor({
      runtimeShell,
      runtimeGates: { runtimeShell: true, streaming: true, directUnicode: true },
      transcriber: createTranscriber(({ audio }) => transcribe(audio)),
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
    });

    session.start();

    expect(runtimeShell.prepare).toHaveBeenCalledTimes(1);
    expect(prepareRecordingPillWindowMock).not.toHaveBeenCalled();

    session.begin('dictation', 'runtime-session');
    expect(runtimeShell.beginCapture).toHaveBeenCalledWith(expect.objectContaining({
      recordingSessionId: 'runtime-session',
      capabilities: { batch: true, streaming: false },
    }));
    expect(runtimeShell.show).toHaveBeenCalledWith(
      'dictation',
      'runtime-session',
      expect.any(Object),
    );

    const ending = session.end();
    expect(runtimeShell.showProcessing).toHaveBeenCalledWith('runtime-session');
    await session.complete(new Uint8Array(64));
    await ending;
    expect(runtimeShell.finish).toHaveBeenCalledTimes(1);
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
      recordingSessionId: expect.any(String),
      sequence: 2,
      revision: 2,
      capabilities: { batch: true, streaming: false },
      outcome: { kind: 'completed' },
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

  it('terminates the correlated run when runtime microphone capture fails', async () => {
    const onError = vi.fn();
    const runtimeShell = {
      prepare: vi.fn(), beginCapture: vi.fn(), endCapture: vi.fn(), cancelCapture: vi.fn(),
      setSelectedDevice: vi.fn(), show: vi.fn(), hide: vi.fn(), updateDurationWarning: vi.fn(),
      updateAudioLevel: vi.fn(), showProcessing: vi.fn(), showFailure: vi.fn(), finish: vi.fn(),
      destroy: vi.fn(), markReady: vi.fn(), markCrashed: vi.fn(), getWebContents: vi.fn(() => null),
      consumeAudioEvent: vi.fn(() => true),
    };
    session = new RecordingSessionCtor({
      runtimeShell,
      runtimeGates: { runtimeShell: true, streaming: true, directUnicode: true },
      transcriber: createTranscriber(({ audio }) => transcribe(audio)),
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      onError,
    });
    session.start();
    session.begin('dictation', 'failed-capture');
    const command = runtimeShell.beginCapture.mock.calls[0]?.[0] as {
      recordingSessionId: string;
      sequence: number;
    };
    const failedCall = (electronMock.ipcMain.on as any).mock.calls.find(
      (call: any) => call[0] === 'runtime:audio-failed',
    );

    failedCall[1]({}, 1, command.recordingSessionId, command.sequence);

    expect(runtimeShell.consumeAudioEvent).toHaveBeenCalledWith(1, 'failed-capture', command.sequence);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Microphone capture failed. Check the selected input device and try again.',
    }));
    expect(session.begin('dictation', 'recovered')).toBe(true);
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
    const onStop = (keyboardStart.mock.calls[0][0] as { onStop: () => void }).onStop;
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

  it('measures keyboard activation through the renderer-confirmed capture start', async () => {
    const lines: string[] = [];
    resetPerformanceMarkerCollectorForTests();
    setPerformanceMarkerCollector(createMarkerCollector(
      {
        enabled: true,
        runId: 'run-test',
        scenarioId: 'recording',
        eventsPath: 'events.jsonl',
      },
      { pid: 99, now: () => 10, writeLine: (line) => lines.push(line) },
    ));

    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      transcriber: createTranscriber(({ audio }) => transcribe(audio)),
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
    });

    session.start();
    const onStart = (keyboardStart.mock.calls[0][0] as {
      onStart: (intent: RecordingIntent) => void;
    }).onStart;
    onStart('dictation');

    let events = lines.map((line) => JSON.parse(line).event);
    expect(events).toEqual(['hotkey.detected', 'recording.begin.accepted']);

    const captureStartedCall = (electronMock.ipcMain.on as any).mock.calls.find(
      (call: any) => call[0] === 'audio-capture-started'
    );
    expect(captureStartedCall).toBeDefined();
    captureStartedCall[1]({});

    const endPromise = session.end();
    const fakeAudioData = new Uint8Array(64);
    await session.complete(fakeAudioData);
    await endPromise;

    events = lines.map((line) => JSON.parse(line).event);
    expect(events).toEqual([
      'hotkey.detected',
      'recording.begin.accepted',
      'audio.capture.started',
      'recording.stop.requested',
      'transcription.batch.requested',
      'transcription.batch.completed',
      'recording.session.completed',
    ]);
    resetPerformanceMarkerCollectorForTests();
  });

  it('runs a paced benchmark WAV without opening the live microphone', async () => {
    const lines: string[] = [];
    setPerformanceMarkerCollector(createMarkerCollector(
      {
        enabled: true,
        runId: 'fixture-run',
        scenarioId: 'dictation-recording',
        eventsPath: 'events.jsonl',
      },
      { pid: 99, now: () => 10, writeLine: (line) => lines.push(line) },
    ));
    const fixtureTranscribe = vi.fn(async () => 'fixture transcript');

    const result = await session.runPerformanceFixture(
      new Uint8Array(64),
      0,
      createTranscriber(({ audio }) => fixtureTranscribe(audio)),
    );

    expect(result?.text).toBe('fixture transcript');
    expect(audioStream.prepare).toHaveBeenCalledTimes(1);
    expect(audioStream.beginCapture).not.toHaveBeenCalled();
    expect(audioStream.endCapture).not.toHaveBeenCalled();
    expect(showRecordingPill).toHaveBeenCalledTimes(1);
    expect(hideRecordingPill).toHaveBeenCalledTimes(1);
    expect(lines.map((line) => JSON.parse(line).event)).toEqual([
      'hotkey.detected',
      'recording.begin.accepted',
      'audio.capture.started',
      'recording.stop.requested',
      'transcription.batch.requested',
      'transcription.batch.completed',
      'recording.session.completed',
    ]);
    resetPerformanceMarkerCollectorForTests();
  });

  it('streams correlated PCM, publishes preview, and returns one finalized transcript', async () => {
    let publishSnapshot!: (snapshot: { sequence: number; committed: string; tentative: string }) => void;
    const sendPcm = vi.fn(async () => undefined);
    const finishStream = vi.fn(async () => {
      publishSnapshot({ sequence: 1, committed: 'Hello world', tentative: 'Hello world maybe' });
      return 'Hello world';
    });
    const cancelStream = vi.fn();
    const batchTranscribe = vi.fn(async () => 'batch fallback');
    const webContents = { send: vi.fn() };
    const runtimeShell = {
      prepare: vi.fn(), beginCapture: vi.fn(), endCapture: vi.fn(), cancelCapture: vi.fn(),
      setSelectedDevice: vi.fn(), show: vi.fn(), hide: vi.fn(), updateDurationWarning: vi.fn(),
      updateAudioLevel: vi.fn(), showProcessing: vi.fn(), showFailure: vi.fn(), finish: vi.fn(),
      showStreamingPreview: vi.fn(), destroy: vi.fn(), markReady: vi.fn(), markCrashed: vi.fn(),
      getWebContents: vi.fn(() => webContents), consumeAudioEvent: vi.fn(() => true),
      acceptsAudioEvent: vi.fn(() => true),
    };
    const streamingTranscriber: Transcriber = {
      id: 'whisper-live-kit',
      capabilities: {
        translation: false,
        automaticLanguageDetection: true,
        dictionaryHints: false,
        authentication: 'optional',
        maxDurationSeconds: null,
      },
      transportCapabilities: { batch: true, streaming: true },
      transcribe: batchTranscribe,
      startStreaming: vi.fn((request: StreamingTranscriptionRequest) => {
        publishSnapshot = request.onSnapshot;
        return { send: sendPcm, finish: finishStream, cancel: cancelStream };
      }),
    };
    const onResult = vi.fn();
    session = new RecordingSessionCtor({
      runtimeShell,
      runtimeGates: { runtimeShell: true, streaming: true, directUnicode: true },
      transcriber: streamingTranscriber,
      getDictationMode: () => 'live',
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      onResult,
    });

    session.start();
    session.begin('dictation', 'live-session');
    publishSnapshot({ sequence: 0, committed: 'Hello ', tentative: 'Hello wor' });
    expect(runtimeShell.showStreamingPreview).toHaveBeenCalledWith(
      'live-session',
      'Hello ',
      'Hello wor',
    );

    const chunkCall = (electronMock.ipcMain.on as any).mock.calls.find(
      (call: any) => call[0] === 'runtime:audio-chunk',
    );
    await chunkCall[1]({}, 1, 'live-session', 1, 0, new Uint8Array(640).buffer);
    expect(sendPcm).toHaveBeenCalledWith(new Uint8Array(640));
    expect(webContents.send).toHaveBeenCalledWith(
      'runtime:audio-chunk-accepted',
      1,
      'live-session',
      1,
      0,
    );

    const ending = session.end();
    const audioReadyCall = (electronMock.ipcMain.on as any).mock.calls.find(
      (call: any) => call[0] === 'runtime:audio-data-ready',
    );
    await audioReadyCall[1]({}, 1, 'live-session', 1, new Uint8Array(128).buffer);

    await expect(ending).resolves.toMatchObject({ text: 'Hello world', intent: 'dictation' });
    expect(finishStream).toHaveBeenCalledTimes(1);
    expect(batchTranscribe).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('uses one same-provider Batch fallback when streaming finalization fails', async () => {
    const batchTranscribe = vi.fn(async () => 'complete batch transcript');
    const cancelStream = vi.fn();
    const streamingTranscriber: Transcriber = {
      id: 'whisper-live-kit',
      capabilities: {
        translation: false,
        automaticLanguageDetection: true,
        dictionaryHints: false,
        authentication: 'optional',
        maxDurationSeconds: null,
      },
      transportCapabilities: { batch: true, streaming: true },
      transcribe: batchTranscribe,
      startStreaming: vi.fn(() => ({
        send: vi.fn(async () => undefined),
        finish: vi.fn(async () => { throw new Error('flush timed out'); }),
        cancel: cancelStream,
      })),
    };
    const runtimeShell = {
      prepare: vi.fn(), beginCapture: vi.fn(), endCapture: vi.fn(), cancelCapture: vi.fn(),
      setSelectedDevice: vi.fn(), show: vi.fn(), hide: vi.fn(), updateDurationWarning: vi.fn(),
      updateAudioLevel: vi.fn(), showProcessing: vi.fn(), showFailure: vi.fn(), finish: vi.fn(),
      showStreamingPreview: vi.fn(), destroy: vi.fn(), markReady: vi.fn(), markCrashed: vi.fn(),
      getWebContents: vi.fn(() => null), consumeAudioEvent: vi.fn(() => true),
      acceptsAudioEvent: vi.fn(() => true),
    };
    session = new RecordingSessionCtor({
      runtimeShell,
      runtimeGates: { runtimeShell: true, streaming: true, directUnicode: true },
      transcriber: streamingTranscriber,
      getDictationMode: () => 'live',
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
    });

    session.begin('dictation', 'fallback-session');
    const ending = session.end();
    await session.complete(new Uint8Array(128).fill(4));

    await expect(ending).resolves.toMatchObject({ text: 'complete batch transcript' });
    expect(batchTranscribe).toHaveBeenCalledTimes(1);
    expect(cancelStream).toHaveBeenCalledTimes(1);
  });

  it('cancels the per-utterance stream when capture returns an empty WAV', async () => {
    const cancelStream = vi.fn();
    const runtimeShell = {
      prepare: vi.fn(), beginCapture: vi.fn(), endCapture: vi.fn(), cancelCapture: vi.fn(),
      setSelectedDevice: vi.fn(), show: vi.fn(), hide: vi.fn(), updateDurationWarning: vi.fn(),
      updateAudioLevel: vi.fn(), showProcessing: vi.fn(), showFailure: vi.fn(), finish: vi.fn(),
      showStreamingPreview: vi.fn(), destroy: vi.fn(), markReady: vi.fn(), markCrashed: vi.fn(),
      getWebContents: vi.fn(() => null), consumeAudioEvent: vi.fn(() => true),
      acceptsAudioEvent: vi.fn(() => true),
    };
    const transcriber: Transcriber = {
      ...createTranscriber(async () => 'unused'),
      id: 'whisper-live-kit',
      transportCapabilities: { batch: true, streaming: true },
      startStreaming: vi.fn(() => ({
        send: vi.fn(async () => undefined),
        finish: vi.fn(async () => ''),
        cancel: cancelStream,
      })),
    };
    session = new RecordingSessionCtor({
      runtimeShell,
      runtimeGates: { runtimeShell: true, streaming: true, directUnicode: true },
      transcriber,
      getDictationMode: () => 'live',
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      onError: vi.fn(),
    });

    session.begin('dictation', 'empty-stream');
    const ending = session.end();
    await session.complete(new Uint8Array(44));

    await expect(ending).rejects.toThrow('No microphone audio was captured');
    expect(cancelStream).toHaveBeenCalledTimes(1);
  });

  it('uses the legacy capture path as Batch when the runtime shell is disabled', async () => {
    const startStreaming = vi.fn(() => ({
      send: vi.fn(async () => undefined),
      finish: vi.fn(async () => ''),
      cancel: vi.fn(),
    }));
    const batchTranscribe = vi.fn(async () => 'legacy batch result');
    const transcriber: Transcriber = {
      ...createTranscriber(batchTranscribe),
      id: 'whisper-live-kit',
      transportCapabilities: { batch: true, streaming: true },
      startStreaming,
    };
    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      transcriber,
      getDictationMode: () => 'live',
      runtimeGates: { runtimeShell: false, streaming: true, directUnicode: true },
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
    });

    session.begin('dictation', 'legacy-live');
    const ending = session.end();
    await session.complete(new Uint8Array(128));

    await expect(ending).resolves.toMatchObject({ text: 'legacy batch result' });
    expect(startStreaming).not.toHaveBeenCalled();
    expect(batchTranscribe).toHaveBeenCalledTimes(1);
  });

  it('carries WhisperLiveKit mandatory Batch capability into the ordinary Batch presentation', async () => {
    const providerTranscriber: Transcriber = {
      id: 'whisper-live-kit',
      capabilities: {
        translation: false,
        automaticLanguageDetection: true,
        dictionaryHints: false,
        authentication: 'optional',
        maxDurationSeconds: null,
      },
      transportCapabilities: { batch: true, streaming: true },
      transcribe: vi.fn(async () => 'WhisperLiveKit batch result'),
    };
    const onResult = vi.fn();
    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      transcriber: providerTranscriber,
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      onResult,
    });

    session.start();
    session.begin('dictation');
    const audioDataReadyCall = (electronMock.ipcMain.on as any).mock.calls.find(
      (call: any) => call[0] === 'audio-data-ready',
    );
    const listener = audioDataReadyCall?.[1] as ((_event: unknown, audio: ArrayBuffer) => Promise<void>);
    const endPromise = session.end();
    await listener({}, new Uint8Array(64).buffer);
    await endPromise;

    expect(showRecordingPill).toHaveBeenCalledWith(
      'dictation',
      expect.any(String),
      expect.objectContaining({ capabilities: { batch: true, streaming: true } }),
    );
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      text: 'WhisperLiveKit batch result',
      capabilities: { batch: true, streaming: true },
    }));
  });

  it('rejects begin() and protects session context while deferred transcription is in-flight', async () => {
    let resolveTranscribe!: (text: string) => void;
    const slowTranscribe = vi.fn(
      () => new Promise<string>((resolve) => { resolveTranscribe = resolve; }),
    );
    const slowTranscriber = createTranscriber(slowTranscribe);

    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      transcriber: slowTranscriber,
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
    });

    const acceptedFirst = session.begin('dictation', 'session-alpha');
    expect(acceptedFirst).toBe(true);

    const endPromise = session.end();
    const completePromise = session.complete(new Uint8Array(64));

    // While transcription is pending, session ownership must not be released:
    const acceptedSecond = session.begin('agent', 'session-beta');
    expect(acceptedSecond).toBe(false);

    // Resolve the deferred transcription
    resolveTranscribe('alpha transcription completed');
    const result = await completePromise;
    const endResult = await endPromise;

    expect(result).toMatchObject({
      text: 'alpha transcription completed',
      intent: 'dictation',
      recordingSessionId: 'session-alpha',
      sequence: 2,
      revision: 2,
    });
    expect(endResult).toEqual(result);

    // After completion reaches terminal state, a new session can begin
    const acceptedThird = session.begin('dictation', 'session-gamma');
    expect(acceptedThird).toBe(true);
  });

  it('handles transcription failure gracefully when end() is triggered via keyboard onStop without unhandled rejection', async () => {
    const onError = vi.fn();
    const failingTranscriber = createTranscriber(
      vi.fn(() => Promise.reject(new Error('Network error during transcription'))),
    );

    session = new RecordingSessionCtor({
      audioCapture: audioStream,
      showRecordingPill,
      hideRecordingPill,
      transcriber: failingTranscriber,
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      onError,
    });

    session.start();
    const hookOptions = keyboardStart.mock.calls[0]?.[0] as {
      onStart: (intent: RecordingIntent) => boolean;
      onStop: () => void;
    };

    hookOptions.onStart('dictation');
    hookOptions.onStop();

    // Trigger audio completion which fails
    const result = await session.complete(new Uint8Array(64));
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Network error during transcription' }));
    expect(session.isActive()).toBe(false);
  });
});
