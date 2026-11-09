import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { DEFAULT_SHORTCUTS } from '../../shared/shortcut-bindings';
import type { RecordingActivationMode, RecordingIntent } from '../../types/ipc';
import type { StreamingTranscriptionRequest, Transcriber } from '../transcription';
import { installElectronMock, resetElectronMock, electronMock } from '../../test/electron-mock';
import type { RecordingSession, RecordingSessionOptions } from '../recording-session';

const vi = { fn: mock };
let RecordingSessionCtor: typeof RecordingSession;

installElectronMock();
mock.module('../native/keyboard', () => ({
  keyboardHook: { start: vi.fn(), stop: vi.fn() },
}));
function createTranscriber(transcribe: Transcriber['transcribe']): Transcriber {
  return {
    id: 'local-whisper-cpp',
    capabilities: {
      maxDurationSeconds: null,
    },
    transcribe,
  };
}

function createRuntimeShellMock() {
  return {
    prepare: vi.fn(),
    beginCapture: vi.fn(),
    endCapture: vi.fn(),
    cancelCapture: vi.fn(),
    setSelectedDevice: vi.fn(),
    destroy: vi.fn(),
    markReady: vi.fn(),
    setRecordingHandlers: vi.fn(),
    getWebContents: vi.fn(),
    markCaptureReady: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    showProcessing: vi.fn(),
    showFailure: vi.fn(),
    finish: vi.fn(),
    updateDurationWarning: vi.fn(),
    updateAudioLevel: vi.fn(),
    showStreamingPreview: vi.fn(),
    showInsertionHalted: vi.fn(),
    acceptsAudioEvent: vi.fn(() => true),
    consumeAudioEvent: vi.fn(() => true),
  };
}

describe('RecordingSession', () => {
  let audioStream: ReturnType<typeof createRuntimeShellMock>;
  let showRecordingPill: ReturnType<typeof vi.fn>;
  let hideRecordingPill: ReturnType<typeof vi.fn>;
  let transcribe: ReturnType<typeof vi.fn>;
  let keyboardStart: ReturnType<typeof vi.fn>;
  let keyboardStop: ReturnType<typeof vi.fn>;
  let captureTarget: ReturnType<typeof vi.fn>;
  let isAgentModeEnabled: ReturnType<typeof vi.fn>;
  let getRecordingActivationMode: ReturnType<typeof vi.fn>;
  let session: RecordingSession;

  function createSession(options: Partial<Omit<RecordingSessionOptions, 'runtimeShell' | 'keyboardHook'>> & { keyboardHook?: Partial<RecordingSessionOptions['keyboardHook']>; runtimeShell?: Partial<RecordingSessionOptions['runtimeShell']>; transcriber?: Transcriber }) {
    return new RecordingSessionCtor({
      getRecordingActivationMode,
      getShortcutBinding: intent => DEFAULT_SHORTCUTS[intent].binding,
      getSelectedDeviceId: () => null,
      getRecognitionSettings: () => ({ language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false }),
      getDictationContext: () => ({ config: { mode: 'batch', formatter: null }, language: 'auto', protectedTerms: [], formatterApiKey: null }),
      getReadinessError: () => null,
      getTranscriber: () => options.transcriber ?? createTranscriber(({ audio }) => transcribe(audio)),
      captureTarget,
      isAgentModeEnabled,
      onResult: () => (options.runtimeShell ?? audioStream).finish(),
      onError: () => {},
      ...options,
      keyboardHook: { start: keyboardStart, stop: keyboardStop, recordingEndedExternally: vi.fn(), ...options.keyboardHook },
      runtimeShell: { ...createRuntimeShellMock(), ...(options.runtimeShell ?? audioStream),
        setRecordingHandlers: handlers => {
          audioStream.setRecordingHandlers(handlers);
        },
      },
    });
  }

  afterAll(() => {
    mock.restore();
  });

  beforeEach(async () => {
    resetElectronMock();
    ({ RecordingSession: RecordingSessionCtor } = await import(`../recording-session?test=${Date.now()}-${Math.random()}`));
    audioStream = createRuntimeShellMock();
    showRecordingPill = audioStream.show;
    hideRecordingPill = audioStream.hide;
    transcribe = vi.fn(async () => 'transcribed text');
    keyboardStart = vi.fn();
    keyboardStop = vi.fn();
    captureTarget = vi.fn(() => ({
      hwnd: 12345,
      kind: 'win32',
      processId: 67890,
      processCreationTime: '2026-01-01T00:00:00.000Z',
      threadId: 111,
      windowClass: 'Notepad',
      executablePath: 'C:\\Windows\\notepad.exe',
      capturedAt: new Date().toISOString(),
    }));
    isAgentModeEnabled = vi.fn(() => false);
    getRecordingActivationMode = vi.fn(() => 'toggle' satisfies RecordingActivationMode);
    session = createSession({
      runtimeShell: audioStream,
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

  it('preserves Sarvam verbatim fillers through recording completion', async () => {
    const { createSarvamTranscriber } = await import('../sarvam');
    const previousFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ transcript: 'um keep uh every word' }))) as unknown as typeof fetch;
    try {
      session = createSession({
        transcriber: createSarvamTranscriber({ model: 'saaras:v4', mode: 'verbatim' }, 'key'),
        getRecognitionSettings: () => ({ language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: true }),
      });
      session.begin();
      const result = await session.complete(new Uint8Array(64));
      expect(result?.text).toBe('um keep uh every word');
    } finally {
      globalThis.fetch = previousFetch;
    }
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
    expect(session.isBusy()).toBe(true);
  });

  it('notifies the owner after a recording start is accepted', () => {
    const onBegin = vi.fn();
    session = createSession({
      runtimeShell: audioStream,
      transcriber: createTranscriber(({ audio }) => transcribe(audio)),
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      onBegin,
    });

    expect(session.begin('agent')).toBe(true);

    expect(onBegin).toHaveBeenCalledWith('agent');
    expect(onBegin).toHaveBeenCalledTimes(1);
  });

  it('pins formatter consent, model, dictionary and resolved credentials at recording start', async () => {
    const context = {
      config: { mode: 'corrected' as const, formatter: {
        baseUrl: 'http://localhost:11434/v1', model: 'original', apiKeyEnvVar: '',
        apiKeySource: 'environment' as const, processingConsent: true,
      } },
      language: 'mr', protectedTerms: ['Shuddhalekhan'], formatterApiKey: 'original-secret',
    };
    const onResult = vi.fn();
    session = createSession({
      runtimeShell: audioStream, transcriber: createTranscriber(async () => 'finished'),
      keyboardHook: { start: keyboardStart, stop: keyboardStop }, isAgentModeEnabled,
      getDictationContext: () => context, onResult,
    });
    session.begin();
    context.config.formatter.model = 'different';
    context.config.formatter.processingConsent = false;
    context.language = 'en';
    context.protectedTerms[0] = 'Different';
    context.formatterApiKey = 'different-secret';
    const ending = session.end();
    await session.complete(new Uint8Array(64));
    const result = await ending;
    expect(result?.dictation).toMatchObject({
      config: { formatter: { model: 'original', processingConsent: true } },
      language: 'mr', protectedTerms: ['Shuddhalekhan'], formatterApiKey: 'original-secret',
    });
  });

  it('keeps one session through final delivery and refuses a second completion or recording', async () => {
    let release!: () => void;
    let started!: () => void;
    const delivering = new Promise<void>(resolve => { started = resolve; });
    const delivery = new Promise<void>(resolve => { release = resolve; });
    const onResult = vi.fn(async () => { started(); await delivery; });
    session = createSession({
      runtimeShell: audioStream, transcriber: createTranscriber(transcribe),
      keyboardHook: { start: keyboardStart, stop: keyboardStop }, isAgentModeEnabled, onResult,
    });
    session.begin();
    const ending = session.end();
    const completion = session.complete(new Uint8Array(64));
    await delivering;
    expect(session.begin()).toBe(false);
    const duplicate = new Uint8Array(64).fill(7);
    expect(await session.complete(duplicate)).toBeNull();
    expect(duplicate.every(value => value === 0)).toBe(true);
    expect(onResult).toHaveBeenCalledTimes(1);
    release();
    await completion;
    expect((await ending)?.text).toBe('transcribed text');
    expect(session.begin()).toBe(true);
    await session.cancel();
  });

  it('aborts final delivery on cancellation and ignores it after a new recording begins', async () => {
    let release!: () => void;
    let started!: () => void;
    const delivering = new Promise<void>(resolve => { started = resolve; });
    const delivery = new Promise<void>(resolve => { release = resolve; });
    let signal: AbortSignal | undefined;
    session = createSession({
      runtimeShell: audioStream, transcriber: createTranscriber(transcribe),
      keyboardHook: { start: keyboardStart, stop: keyboardStop }, isAgentModeEnabled,
      onResult: async result => { signal = result?.signal; started(); await delivery; },
    });
    session.begin();
    const ending = session.end();
    const completion = session.complete(new Uint8Array(64));
    await delivering;
    await session.cancel();
    expect(signal?.aborted).toBe(true);
    expect(await ending).toBeNull();
    expect(session.begin('dictation', 'replacement')).toBe(true);
    release();
    expect(await completion).toBeNull();
    expect(session.isBusy()).toBe(true);
    await session.cancel();
  });

  it.each(['dictation', 'agent'] as const)('automatically previews %s with Push to Talk and no foreground target', async (intent: RecordingIntent) => {
    let publish!: StreamingTranscriptionRequest['onSnapshot'];
    const onResult = vi.fn();
    const batch = vi.fn(async () => 'unexpected batch');
    session = createSession({
      runtimeShell: audioStream,
      transcriber: { ...createTranscriber(batch),
        startStreaming: request => {
          publish = request.onSnapshot;
          return { send: async () => undefined, finish: async () => 'final words', cancel: vi.fn() };
        },
      },
      captureTarget: () => null, getRecordingActivationMode: () => 'push-to-talk',
      getRecognitionSettings: () => ({ language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: true }),
      keyboardHook: { start: keyboardStart, stop: keyboardStop }, isAgentModeEnabled, onResult,
    });
    expect(session.begin(intent, 'preview')).toBe(true);
    publish({ sequence: 0, committed: 'um final words', tentative: 'um final words maybe' });
    expect(audioStream.showStreamingPreview).toHaveBeenCalledWith('preview', 'um final words', 'um final words maybe');
    expect(onResult).not.toHaveBeenCalled();
    const ending = session.end();
    await session.complete(new Uint8Array(64));
    expect((await ending)?.text).toBe('final words');
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(batch).not.toHaveBeenCalled();
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
        }),
    );
    const envelope = showRecordingPill.mock.calls[0]?.[2] as { recordingSessionId: string };
    expect(showRecordingPill.mock.calls[0]?.[1]).toBe(envelope.recordingSessionId);
  });

  it('prevents keyboard-triggered recording when the active provider is not ready', () => {
    const readinessError = new Error('OpenAI model is not configured.');
    const onError = vi.fn();
    session = createSession({
      runtimeShell: audioStream,
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
    expect(session.isBusy()).toBe(false);
  });

  it('pins recognition settings when recording starts even if Settings changes before completed audio arrives', async () => {
    const providerTranscriber: Transcriber = {
      id: 'local-whisper-cpp',
      capabilities: {
        maxDurationSeconds: null,
      },
      transcribe: vi.fn(async () => 'provider text'),
    };
    const recognition = { language: 'mr', task: 'translate' as const, dictionary: ['Shuddhalekhan'], removeFillerWords: true };
    session = createSession({
      runtimeShell: audioStream,
      transcriber: providerTranscriber,
      getRecognitionSettings: () => recognition,
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
    });

    session.begin('dictation');
    recognition.dictionary[0] = 'Different term';
    recognition.language = 'en';
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
      signal: expect.any(AbortSignal),
    });
    expect(audio.every((byte) => byte === 0)).toBe(true);
  });

  it('ends recording and resolves with transcribed text and original intent', async () => {
    captureTarget.mockImplementation(() => { throw new Error('Dictation target backend unavailable'); });
    session.begin('agent');

    const resultPromise = session.end();
    await session.complete(new Uint8Array(64));

    await expect(resultPromise).resolves.toMatchObject({
      text: 'transcribed text',
      intent: 'agent' satisfies RecordingIntent,
      targetSnapshot: null,
      recordingSessionId: expect.any(String),
      outcome: { kind: 'completed' },
    });
    expect(audioStream.showProcessing).toHaveBeenCalledTimes(1);
    expect(captureTarget).not.toHaveBeenCalled();
    expect(audioStream.endCapture).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith(new Uint8Array(64));
    expect(session.isBusy()).toBe(false);
  });

  it.each(['', '   '])('reports an empty recognition result instead of silently dismissing the recording (%j)', async (text: string) => {
    const onError = vi.fn();
    const onResult = vi.fn();
    session = createSession({
      runtimeShell: audioStream, transcriber: createTranscriber(async () => text),
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget, isAgentModeEnabled, onError, onResult,
    });
    session.begin('dictation');
    const ending = session.end().catch(error => error);
    const audio = new Uint8Array(64);
    await session.complete(audio);
    const failure = await ending;
    expect(failure.message).toContain('No speech was recognized');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('nearly silent') }));
    expect(onResult).not.toHaveBeenCalled();
    expect(session.isBusy()).toBe(false);
    expect(audio.every(byte => byte === 0)).toBe(true);
  });

  it('tells the user a no-speech recording was clipping rather than too quiet', async () => {
    session = createSession({
      runtimeShell: audioStream, transcriber: createTranscriber(async () => ''),
      keyboardHook: { start: keyboardStart, stop: keyboardStop }, captureTarget, isAgentModeEnabled,
    });
    session.begin('dictation');
    const ending = session.end().catch(error => error);
    const audio = new Uint8Array(64);
    const pcm = new Int16Array(audio.buffer, 44, 10);
    pcm.forEach((_, index) => { pcm[index] = index % 2 ? 32_767 : -32_768; });
    await session.complete(audio);
    expect((await ending).message).toContain('clipping');
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
    session = createSession({
      runtimeShell: audioStream,
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
      outcome: { kind: 'completed' },
    });
  });

  it('captures the foreground target when recording begins and returns it with the result', async () => {
    const snapshot = {
      hwnd: 42,
      kind: 'win32',
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
    session = createSession({
      runtimeShell: audioStream,
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

  it('aborts in-flight batch recognition when the recording is cancelled', async () => {
    let signal: AbortSignal | undefined;
    session = createSession({
      runtimeShell: audioStream,
      transcriber: createTranscriber((request) => {
        signal = request.signal;
        return new Promise(() => undefined);
      }),
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
    });
    session.begin('dictation');
    const resultPromise = session.end();
    void session.complete(new Uint8Array(64));

    expect(signal?.aborted).toBe(false);
    await session.cancel();

    expect(signal?.aborted).toBe(true);
    await expect(resultPromise).resolves.toBeNull();
  });

  it('releases the session and scrubs the WAV when cancelled under a provider that ignores abort', async () => {
    session = createSession({
      runtimeShell: audioStream,
      transcriber: createTranscriber(() => new Promise(() => undefined)),
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
    });
    session.begin('dictation');
    void session.end();
    const audio = new Uint8Array(64).fill(7);
    const completion = session.complete(audio);
    await session.cancel();

    await expect(completion).resolves.toBeNull();
    expect(audio.every((byte) => byte === 0)).toBe(true);
    expect(session.begin('dictation')).toBe(true);
  });

  it('fails batch recognition at the deadline by aborting the provider request, without retrying', async () => {
    const timers: Array<{ callback: () => void; delay: number }> = [];
    let signal: AbortSignal | undefined;
    const transcribeHung = vi.fn((request: { signal?: AbortSignal }) => {
      signal = request.signal;
      return new Promise<string>(() => undefined);
    });
    const onError = vi.fn();
    session = createSession({
      runtimeShell: audioStream,
      transcriber: createTranscriber(transcribeHung),
      setTimeoutFn: ((callback: () => void, delay: number) =>
        timers.push({ callback, delay }) as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout,
      clearTimeoutFn: (() => undefined) as typeof clearTimeout,
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      onError,
    });
    session.begin('dictation');
    const ending = session.end();
    const audio = new Uint8Array(64).fill(7);
    const completion = session.complete(audio);
    timers.find((timer) => timer.delay === 120_000)?.callback();

    await expect(ending).rejects.toThrow('did not finish in time');
    await expect(completion).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(transcribeHung).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Transcription did not finish in time.' }));
    expect(audio.every((byte) => byte === 0)).toBe(true);
  });

  it('cancels recording and tells the audio stream to discard capture', async () => {
    session.begin('dictation');

    await expect(session.cancel()).resolves.toBeUndefined();

    expect(hideRecordingPill).toHaveBeenCalled();
    expect(audioStream.cancelCapture).toHaveBeenCalledTimes(1);
    expect(session.isBusy()).toBe(false);
  });

  it('clears recording state when the runtime shell crashes', () => {
    session.begin('dictation', 'crashed-session');
    session.handleAudioRendererCrash('render-process-gone');

    expect(hideRecordingPill).toHaveBeenCalled();
    expect(session.isBusy()).toBe(false);

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
    session.startKeyboardHook();
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
    session = createSession({
      runtimeShell: audioStream,
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

    expect(audioStream.prepare).toHaveBeenCalledTimes(1);
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
      setRecordingHandlers: vi.fn(),
      getWebContents: vi.fn(() => null),
      consumeAudioEvent: vi.fn(() => true),
    };
    session = createSession({
      runtimeShell,
      transcriber: createTranscriber(({ audio }) => transcribe(audio)),
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
    });

    session.start();

    expect(runtimeShell.prepare).toHaveBeenCalledTimes(1);

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


  it('calls onResult when runtime audio arrives and transcription succeeds', async () => {
    const onResult = vi.fn();
    const onError = vi.fn();
    session = createSession({
      runtimeShell: audioStream,
      transcriber: createTranscriber(({ audio }) => transcribe(audio)),
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      onResult,
      onError,
    });

    session.start();
    session.begin('dictation');

    const audioDataReadyCall = [null, audioStream.setRecordingHandlers.mock.calls.at(-1)?.[0].onAudioData];
    expect(audioDataReadyCall).toBeDefined();
    const listener = audioDataReadyCall[1];

    const endPromise = session.end();

    const command = audioStream.beginCapture.mock.calls[0]?.[0] as {
      recordingSessionId: string;
      sequence: number;
    };
    const fakeAudioData = new Uint8Array(64);
    await listener({}, 1, command.recordingSessionId, command.sequence, fakeAudioData.buffer);

    await endPromise;
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      text: 'transcribed text',
      intent: 'dictation',
      targetSnapshot: expect.any(Object),
      recordingSessionId: expect.any(String),
      outcome: { kind: 'completed' },
    }));
    expect(onError).not.toHaveBeenCalled();
  });

  it('calls onError when transcription fails', async () => {
    const onResult = vi.fn();
    const onError = vi.fn();
    const failingTranscribe = vi.fn(() => Promise.reject(new Error('Whisper offline')));

    session = createSession({
      runtimeShell: audioStream,
      transcriber: createTranscriber(({ audio }) => failingTranscribe(audio)),
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      onResult,
      onError,
    });

    session.start();
    session.begin('dictation');

    const audioDataReadyCall = [null, audioStream.setRecordingHandlers.mock.calls.at(-1)?.[0].onAudioData];
    const listener = audioDataReadyCall[1];

    const endPromise = session.end();

    const command = audioStream.beginCapture.mock.calls[0]?.[0] as {
      recordingSessionId: string;
      sequence: number;
    };
    const fakeAudioData = new Uint8Array(64).fill(9);
    await listener({}, 1, command.recordingSessionId, command.sequence, fakeAudioData.buffer);

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
    session = createSession({
      runtimeShell,
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
    const failedCall = [null, audioStream.setRecordingHandlers.mock.calls.at(-1)?.[0].onAudioFailed];

    failedCall[1]({}, 1, command.recordingSessionId, command.sequence);

    expect(runtimeShell.consumeAudioEvent).toHaveBeenCalledWith(1, 'failed-capture', command.sequence);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Microphone capture failed. Check the selected input device and try again.',
    }));
    expect(session.begin('dictation', 'recovered')).toBe(true);
  });

  it('fails a capture whose renderer never becomes ready, releases the shortcut, and accepts a new recording', async () => {
    const timers: Array<() => void> = [];
    const onError = vi.fn();
    const recordingEndedExternally = vi.fn();
    session = createSession({
      runtimeShell: audioStream,
      transcriber: createTranscriber(async () => 'unused'),
      keyboardHook: { start: keyboardStart, stop: keyboardStop, recordingEndedExternally },
      captureTarget,
      isAgentModeEnabled,
      onError,
      setTimeoutFn: ((callback: () => void) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutFn: vi.fn(),
    });
    session.begin('dictation', 'never-ready');
    timers[0]();
    expect(audioStream.cancelCapture).toHaveBeenCalledTimes(1);
    expect(recordingEndedExternally).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('did not start in time') }));
    expect(session.isBusy()).toBe(false);
    expect(session.begin('dictation', 'replacement')).toBe(true);
    timers[0]();
    expect(audioStream.cancelCapture).toHaveBeenCalledTimes(1);
    await session.cancel();
  });

  it('warns for the final ten seconds and auto-stops a duration-limited provider exactly once', async () => {
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    const recordingEndedExternally = vi.fn();
    const limitedTranscriber: Transcriber = {
      ...createTranscriber(async () => 'limited result'),
      id: 'google-cloud-speech-v2',
      capabilities: {
        maxDurationSeconds: 55,
      },
    };
    session = createSession({
      runtimeShell: audioStream,
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

    const sender = {};
    audioStream.getWebContents.mockReturnValue(sender);
    session.start();
    session.begin('dictation', 'limited-capture');
    expect(timers.map(timer => timer.delay)).toEqual([30_000]);
    const ready = electronMock.ipcMain.on.mock.calls.find((call: unknown[]) => call[0] === 'runtime:audio-ready')?.[1];
    expect(ready).toBeDefined();
    const command = audioStream.beginCapture.mock.calls[0]?.[0];
    ready({ sender: {} }, 1, command.recordingSessionId, command.sequence);
    ready({ sender }, 1, 'obsolete-session', command.sequence);
    audioStream.acceptsAudioEvent.mockReturnValue(false);
    ready({ sender }, 99, command.recordingSessionId, command.sequence);
    expect(timers.map(timer => timer.delay)).toEqual([30_000]);
    expect(audioStream.markCaptureReady).not.toHaveBeenCalled();
    audioStream.acceptsAudioEvent.mockReturnValue(true);
    ready({ sender }, 1, command.recordingSessionId, command.sequence);
    ready({ sender }, 1, command.recordingSessionId, command.sequence);
    expect(audioStream.markCaptureReady).toHaveBeenCalledTimes(1);
    expect(timers[0].cleared).toBe(true);
    expect(timers.filter(timer => !timer.cleared).map((timer) => timer.delay)).toEqual([
      45000, 46000, 47000, 48000, 49000, 50000, 51000, 52000, 53000, 54000, 55000,
    ]);
    timers.find((timer) => timer.delay === 45000)?.callback();
    expect(audioStream.updateDurationWarning).toHaveBeenCalledWith(10);
    timers.find((timer) => timer.delay === 54000)?.callback();
    expect(audioStream.updateDurationWarning).toHaveBeenCalledWith(1);
    timers.find((timer) => timer.delay === 55000)?.callback();
    timers.find((timer) => timer.delay === 55000)?.callback();

    expect(audioStream.endCapture).toHaveBeenCalledTimes(1);
    expect(recordingEndedExternally).toHaveBeenCalledTimes(1);
    expect(audioStream.showProcessing).toHaveBeenCalledTimes(1);
    expect(session.isBusy()).toBe(true);
    ready({ sender }, 1, command.recordingSessionId, command.sequence);
    expect(audioStream.markCaptureReady).toHaveBeenCalledTimes(1);
    session.begin('agent');
    expect(audioStream.beginCapture).toHaveBeenCalledTimes(1);
  });

  it('does not double-invoke onResult when triggered via keyboard hook', async () => {
    const onResult = vi.fn();
    session = createSession({
      runtimeShell: audioStream,
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

    // Trigger runtime audio completion
    const audioDataReadyCall = [null, audioStream.setRecordingHandlers.mock.calls.at(-1)?.[0].onAudioData];
    const listener = audioDataReadyCall[1];

    const command = audioStream.beginCapture.mock.calls[0]?.[0] as {
      recordingSessionId: string;
      sequence: number;
    };
    const fakeAudioData = new Uint8Array(64);
    await listener({}, 1, command.recordingSessionId, command.sequence, fakeAudioData.buffer);

    // The keyboard onStop path attaches onResult only when the session's own
    // callback is unset; here the session owns delivery, so the hook's fire-
    // and-forget end() must not produce a second transcription result.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('streams correlated PCM, publishes revisable previews, and returns the authoritative provider final', async () => {
    let publishSnapshot!: (snapshot: { sequence: number; committed: string; tentative: string }) => void;
    const sentPcm: Uint8Array[] = [];
    const sendPcm = vi.fn(async (pcm: Uint8Array) => {
      sentPcm.push(new Uint8Array(pcm));
    });
    const finishStream = vi.fn(async () => {
      publishSnapshot({ sequence: 1, committed: 'Yellow world', tentative: 'Yellow world maybe' });
      return 'Hello, world.';
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
    session = createSession({
      runtimeShell,
      transcriber: streamingTranscriber,
      getRecordingActivationMode,
      keyboardHook: {
        start: keyboardStart,
        stop: keyboardStop,
      },
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
    await chunkCall[1]({}, 1, 'live-session', 1, 0, new Uint8Array(640).fill(9).buffer);
    expect(sentPcm).toEqual([new Uint8Array(640).fill(9)]);
    expect(webContents.send).toHaveBeenCalledWith(
      'runtime:audio-chunk-accepted',
      1,
      'live-session',
      1,
      0,
    );

    const ending = session.end();
    const audioReadyCall = [null, audioStream.setRecordingHandlers.mock.calls.at(-1)?.[0].onAudioData];
    await audioReadyCall[1]({}, 1, 'live-session', 1, new Uint8Array(128).buffer);

    await expect(ending).resolves.toMatchObject({
      text: 'Hello, world.',
      intent: 'dictation',
      outcome: { kind: 'completed' },
    });
    expect(runtimeShell.showStreamingPreview).toHaveBeenLastCalledWith(
      'live-session',
      'Yellow world',
      'Yellow world maybe',
    );
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
    session = createSession({
      runtimeShell,
      transcriber: streamingTranscriber,
      getRecordingActivationMode,
      keyboardHook: {
        start: keyboardStart,
        stop: keyboardStop,
      },
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

  it('captures no live audio for an offline Managed Local recording and decodes the completed WAV once', async () => {
    const batchTranscribe = vi.fn(async () => 'whole recording transcript');
    const runtimeShell = createRuntimeShellMock();
    session = createSession({
      runtimeShell,
      transcriber: { ...createTranscriber(batchTranscribe), id: 'managed-local' },
      getRecordingActivationMode,
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
    });

    session.begin('dictation', 'offline-session');
    expect(runtimeShell.beginCapture.mock.calls[0][0]).toMatchObject({ streamingActive: false });
    const ending = session.end();
    await session.complete(new Uint8Array(128).fill(4));

    await expect(ending).resolves.toMatchObject({ text: 'whole recording transcript' });
    expect(batchTranscribe).toHaveBeenCalledTimes(1);
  });

  it('does not fall back or deliver a transcript when cancelled during stream finalization', async () => {
    let rejectFinalization!: (error: Error) => void;
    let markFinalizationStarted!: () => void;
    const finalizationStarted = new Promise<void>((resolve) => {
      markFinalizationStarted = resolve;
    });
    const finishStream = vi.fn(() => {
      markFinalizationStarted();
      return new Promise<string>((_resolve, reject) => {
        rejectFinalization = reject;
      });
    });
    const batchTranscribe = vi.fn(async () => 'late batch transcript');
    const cancelStream = vi.fn(() => rejectFinalization(new Error('cancelled')));
    const onResult = vi.fn();
    const runtimeShell = {
      prepare: vi.fn(), beginCapture: vi.fn(), endCapture: vi.fn(), cancelCapture: vi.fn(),
      setSelectedDevice: vi.fn(), show: vi.fn(), hide: vi.fn(), updateDurationWarning: vi.fn(),
      updateAudioLevel: vi.fn(), showProcessing: vi.fn(), showFailure: vi.fn(), finish: vi.fn(),
      showStreamingPreview: vi.fn(), destroy: vi.fn(), markReady: vi.fn(), markCrashed: vi.fn(),
      getWebContents: vi.fn(() => null), consumeAudioEvent: vi.fn(() => true),
      acceptsAudioEvent: vi.fn(() => true),
    };
    const streamingTranscriber: Transcriber = {
      ...createTranscriber(batchTranscribe),
      id: 'whisper-live-kit',
      transportCapabilities: { batch: true, streaming: true },
      startStreaming: vi.fn(() => ({
        send: vi.fn(async () => undefined),
        finish: finishStream,
        cancel: cancelStream,
      })),
    };
    session = createSession({
      runtimeShell,
      transcriber: streamingTranscriber,
      getRecordingActivationMode,
      keyboardHook: {
        start: keyboardStart,
        stop: keyboardStop,
      },
      captureTarget,
      isAgentModeEnabled,
      onResult,
    });

    session.begin('dictation', 'cancelled-finalization');
    const ending = session.end();
    const completion = session.complete(new Uint8Array(128).fill(4));
    await finalizationStarted;
    await session.cancel();

    await expect(ending).resolves.toBeNull();
    await expect(completion).resolves.toBeNull();
    expect(cancelStream).toHaveBeenCalledTimes(1);
    expect(batchTranscribe).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('does not report a stale batch failure after cancellation', async () => {
    let rejectBatch!: (error: Error) => void;
    let markBatchStarted!: () => void;
    const batchStarted = new Promise<void>((resolve) => {
      markBatchStarted = resolve;
    });
    const batchTranscribe = vi.fn(() => {
      markBatchStarted();
      return new Promise<string>((_resolve, reject) => {
        rejectBatch = reject;
      });
    });
    const cancelStream = vi.fn();
    const onError = vi.fn();
    const onResult = vi.fn();
    const runtimeShell = {
      prepare: vi.fn(), beginCapture: vi.fn(), endCapture: vi.fn(), cancelCapture: vi.fn(),
      setSelectedDevice: vi.fn(), show: vi.fn(), hide: vi.fn(), updateDurationWarning: vi.fn(),
      updateAudioLevel: vi.fn(), showProcessing: vi.fn(), showFailure: vi.fn(), finish: vi.fn(),
      showStreamingPreview: vi.fn(), destroy: vi.fn(), markReady: vi.fn(), markCrashed: vi.fn(),
      getWebContents: vi.fn(() => null), consumeAudioEvent: vi.fn(() => true),
      acceptsAudioEvent: vi.fn(() => true),
    };
    const streamingTranscriber: Transcriber = {
      ...createTranscriber(batchTranscribe),
      id: 'whisper-live-kit',
      transportCapabilities: { batch: true, streaming: true },
      startStreaming: vi.fn(() => ({
        send: vi.fn(async () => undefined),
        finish: vi.fn(async () => { throw new Error('stream failed'); }),
        cancel: cancelStream,
      })),
    };
    session = createSession({
      runtimeShell,
      transcriber: streamingTranscriber,
      getRecordingActivationMode,
      keyboardHook: {
        start: keyboardStart,
        stop: keyboardStop,
      },
      captureTarget,
      isAgentModeEnabled,
      onError,
      onResult,
    });

    session.begin('dictation', 'cancelled-batch-failure');
    const ending = session.end();
    const completion = session.complete(new Uint8Array(128).fill(4));
    await batchStarted;
    await session.cancel();
    rejectBatch(new Error('late batch failure'));

    await expect(ending).resolves.toBeNull();
    await expect(completion).resolves.toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
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
    session = createSession({
      runtimeShell,
      transcriber,
      getRecordingActivationMode,
      keyboardHook: {
        start: keyboardStart,
        stop: keyboardStop,
      },
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

  it('returns Recognized So Far when streaming and Batch fallback both fail', async () => {
    let publishSnapshot!: (snapshot: { sequence: number; committed: string; tentative: string }) => void;
    const onError = vi.fn();
    const onResult = vi.fn();
    const runtimeShell = {
      prepare: vi.fn(), beginCapture: vi.fn(), endCapture: vi.fn(), cancelCapture: vi.fn(),
      setSelectedDevice: vi.fn(), show: vi.fn(), hide: vi.fn(), updateDurationWarning: vi.fn(),
      updateAudioLevel: vi.fn(), showProcessing: vi.fn(), showFailure: vi.fn(), finish: vi.fn(),
      showStreamingPreview: vi.fn(), destroy: vi.fn(), markReady: vi.fn(), markCrashed: vi.fn(),
      getWebContents: vi.fn(() => null), consumeAudioEvent: vi.fn(() => true),
      acceptsAudioEvent: vi.fn(() => true),
    };
    const transcriber: Transcriber = {
      ...createTranscriber(async () => { throw new Error('Batch fallback failed'); }),
      id: 'whisper-live-kit',
      transportCapabilities: { batch: true, streaming: true },
      startStreaming: vi.fn((request: StreamingTranscriptionRequest) => {
        publishSnapshot = request.onSnapshot;
        return {
          send: vi.fn(async () => undefined),
          finish: vi.fn(async () => { throw new Error('stream finalization failed'); }),
          cancel: vi.fn(),
        };
      }),
    };
    session = createSession({
      runtimeShell,
      transcriber,
      getRecordingActivationMode,
      keyboardHook: {
        start: keyboardStart,
        stop: keyboardStop,
      },
      captureTarget,
      isAgentModeEnabled,
      onError,
      onResult,
    });

    session.begin('dictation', 'recognized-so-far');
    publishSnapshot({ sequence: 0, committed: 'recognized so far', tentative: 'recognized so far maybe' });
    const ending = session.end();
    const completion = session.complete(new Uint8Array(128).fill(4));

    await expect(completion).resolves.toMatchObject({
      text: 'recognized so far',
      outcome: { kind: 'failed', message: 'Batch fallback failed' },
    });
    await expect(ending).resolves.toMatchObject({ text: 'recognized so far' });
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ text: 'recognized so far' }));
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps Recognized So Far without a Batch retry when stream finalization outlives the deadline', async () => {
    let publishSnapshot!: (snapshot: { sequence: number; committed: string; tentative: string }) => void;
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const batchTranscribe = vi.fn(async () => 'late batch transcript');
    const cancelStream = vi.fn();
    const transcriber: Transcriber = {
      ...createTranscriber(batchTranscribe),
      id: 'whisper-live-kit',
      transportCapabilities: { batch: true, streaming: true },
      startStreaming: vi.fn((request: StreamingTranscriptionRequest) => {
        publishSnapshot = request.onSnapshot;
        return {
          send: vi.fn(async () => undefined),
          finish: vi.fn(() => new Promise<string>(() => undefined)),
          cancel: cancelStream,
        };
      }),
    };
    const onResult = vi.fn();
    session = createSession({
      runtimeShell: audioStream,
      transcriber,
      setTimeoutFn: ((callback: () => void, delay: number) =>
        timers.push({ callback, delay }) as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout,
      clearTimeoutFn: (() => undefined) as typeof clearTimeout,
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      onResult,
    });

    session.begin('dictation', 'deadline');
    publishSnapshot({ sequence: 0, committed: 'recognized so far', tentative: 'recognized so far maybe' });
    void session.end();
    const completion = session.complete(new Uint8Array(128).fill(4));
    await Promise.resolve();
    timers.find((timer) => timer.delay === 120_000)?.callback();

    const result = await completion;
    expect(result).toMatchObject({
      text: 'recognized so far',
      outcome: { kind: 'failed', message: 'Transcription did not finish in time.' },
    });
    // Only recognition was aborted; the run stays deliverable.
    expect(result?.signal.aborted).toBe(false);
    expect(cancelStream).toHaveBeenCalled();
    expect(batchTranscribe).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('releases the preview provider when cancelling a recording', async () => {
    const cancelStream = vi.fn();
    const runtimeShell = {
      prepare: vi.fn(), beginCapture: vi.fn(), endCapture: vi.fn(), cancelCapture: vi.fn(),
      setSelectedDevice: vi.fn(), show: vi.fn(), hide: vi.fn(), updateDurationWarning: vi.fn(),
      updateAudioLevel: vi.fn(), showProcessing: vi.fn(), showFailure: vi.fn(), finish: vi.fn(),
      showStreamingPreview: vi.fn(), destroy: vi.fn(), markReady: vi.fn(), markCrashed: vi.fn(),
      getWebContents: vi.fn(() => null), consumeAudioEvent: vi.fn(() => true),
      acceptsAudioEvent: vi.fn(() => true),
    };
    const streamingTranscriber: Transcriber = {
      ...createTranscriber(async () => 'unused'),
      id: 'whisper-live-kit',
      transportCapabilities: { batch: true, streaming: true },
      startStreaming: vi.fn(() => ({
        send: vi.fn(async () => undefined),
        finish: vi.fn(async () => 'cancelled transcript'),
        cancel: cancelStream,
      })),
    };
    session = createSession({
      runtimeShell,
      transcriber: streamingTranscriber,
      getRecordingActivationMode,
      keyboardHook: {
        start: keyboardStart,
        stop: keyboardStop,
      },
      captureTarget,
      isAgentModeEnabled,
    });

    session.begin('dictation', 'live-cancel');
    await session.cancel();
    expect(cancelStream).toHaveBeenCalled();
  });

  it('carries WhisperLiveKit mandatory Batch capability into the ordinary Batch presentation', async () => {
    const providerTranscriber: Transcriber = {
      id: 'whisper-live-kit',
      capabilities: {
        maxDurationSeconds: null,
      },
      transportCapabilities: { batch: true, streaming: true },
      transcribe: vi.fn(async () => 'WhisperLiveKit batch result'),
    };
    const onResult = vi.fn();
    session = createSession({
      runtimeShell: audioStream,
      transcriber: providerTranscriber,
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
      onResult,
    });

    session.start();
    session.begin('dictation');
    const audioDataReadyCall = [null, audioStream.setRecordingHandlers.mock.calls.at(-1)?.[0].onAudioData];
    const listener = audioDataReadyCall?.[1] as (
      _event: unknown,
      generation: number,
      recordingSessionId: string,
      sequence: number,
      audio: ArrayBuffer,
    ) => Promise<void>;
    const command = audioStream.beginCapture.mock.calls[0]?.[0] as {
      recordingSessionId: string;
      sequence: number;
    };
    const endPromise = session.end();
    await listener({}, 1, command.recordingSessionId, command.sequence, new Uint8Array(64).buffer);
    await endPromise;

    expect(showRecordingPill).toHaveBeenCalledWith(
      'dictation',
      expect.any(String),
      expect.objectContaining({ capabilities: { batch: true, streaming: true } }),
    );
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      text: 'WhisperLiveKit batch result',
    }));
  });

  it('rejects begin() and protects session context while deferred transcription is in-flight', async () => {
    let resolveTranscribe!: (text: string) => void;
    const slowTranscribe = vi.fn(
      () => new Promise<string>((resolve) => { resolveTranscribe = resolve; }),
    );
    const slowTranscriber = createTranscriber(slowTranscribe);

    session = createSession({
      runtimeShell: audioStream,
      transcriber: slowTranscriber,
      keyboardHook: { start: keyboardStart, stop: keyboardStop },
      captureTarget,
      isAgentModeEnabled,
    });

    const acceptedFirst = session.begin('dictation', 'session-alpha');
    expect(acceptedFirst).toBe(true);
    expect(session.isBusy()).toBe(true);

    const endPromise = session.end();
    expect(session.isBusy()).toBe(true);
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
    });
    expect(endResult).toEqual(result);
    expect(session.isBusy()).toBe(false);

    // After completion reaches terminal state, a new session can begin
    const acceptedThird = session.begin('dictation', 'session-gamma');
    expect(acceptedThird).toBe(true);
  });

  it('handles transcription failure gracefully when end() is triggered via keyboard onStop without unhandled rejection', async () => {
    const onError = vi.fn();
    const failingTranscriber = createTranscriber(
      vi.fn(() => Promise.reject(new Error('Network error during transcription'))),
    );

    session = createSession({
      runtimeShell: audioStream,
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
    expect(session.isBusy()).toBe(false);
  });
});
