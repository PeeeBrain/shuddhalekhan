import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { RecordingIntent } from '../../types/ipc';
import { installElectronMock } from '../../test/electron-mock';
import type { RecordingSession } from '../recording-session';
import type { AudioStreamAdapter } from '../audio-stream';

const vi = { fn: mock };
let RecordingSessionCtor: typeof RecordingSession;

installElectronMock();
mock.module('../audio-window', () => ({
  createAudioWindow: vi.fn(),
  getAudioWindow: vi.fn(),
  destroyAudioWindow: vi.fn(),
}));
mock.module('../native/keyboard', () => ({
  keyboardHook: { start: vi.fn(), stop: vi.fn() },
}));
mock.module('../recording-pill', () => ({
  showRecordingPill: vi.fn(),
  hideRecordingPill: vi.fn(),
}));

function createAudioStreamMock(): AudioStreamAdapter & {
  [K in keyof AudioStreamAdapter]: ReturnType<typeof vi.fn>;
} {
  return {
    prepare: vi.fn(),
    beginCapture: vi.fn(),
    endCapture: vi.fn(),
    cancelCapture: vi.fn(),
    markReady: vi.fn(),
    markCrashed: vi.fn(),
    isStreamReady: vi.fn(() => true),
    setSelectedDevice: vi.fn(),
    destroy: vi.fn(),
  };
}

describe('RecordingSession', () => {
  let audioStream: ReturnType<typeof createAudioStreamMock>;
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
    ({ RecordingSession: RecordingSessionCtor } = await import(`../recording-session?test=${Date.now()}-${Math.random()}`));
    audioStream = createAudioStreamMock();
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
      audioStream,
      showRecordingPill,
      hideRecordingPill,
      transcribe,
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
});
