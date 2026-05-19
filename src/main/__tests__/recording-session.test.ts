import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { RecordingIntent } from '../../types/ipc';
import { installElectronMock } from '../../test/electron-mock';
import type { RecordingSession } from '../recording-session';

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

function createWindow({ isLoading = false } = {}) {
  return {
    webContents: {
      send: vi.fn(),
      isLoading: vi.fn(() => isLoading),
      on: vi.fn(),
    },
    isDestroyed: vi.fn(() => false),
  };
}

describe('RecordingSession', () => {
  let audioWindow: ReturnType<typeof createWindow>;
  let createAudioWindow: ReturnType<typeof vi.fn>;
  let getAudioWindow: ReturnType<typeof vi.fn>;
  let destroyAudioWindow: ReturnType<typeof vi.fn>;
  let showRecordingPill: ReturnType<typeof vi.fn>;
  let hideRecordingPill: ReturnType<typeof vi.fn>;
  let transcribe: ReturnType<typeof vi.fn>;
  let keyboardStart: ReturnType<typeof vi.fn>;
  let keyboardStop: ReturnType<typeof vi.fn>;
  let isAgentModeEnabled: ReturnType<typeof vi.fn>;
  let session: RecordingSession;

  afterAll(() => {
    mock.restore();
  });

  beforeEach(async () => {
    ({ RecordingSession: RecordingSessionCtor } = await import(`../recording-session?test=${Date.now()}-${Math.random()}`));
    audioWindow = createWindow();
    createAudioWindow = vi.fn(() => audioWindow);
    getAudioWindow = vi.fn(() => audioWindow);
    destroyAudioWindow = vi.fn();
    showRecordingPill = vi.fn();
    hideRecordingPill = vi.fn();
    transcribe = vi.fn(async () => 'transcribed text');
    keyboardStart = vi.fn();
    keyboardStop = vi.fn();
    isAgentModeEnabled = vi.fn(() => false);
    session = new RecordingSessionCtor({
      createAudioWindow,
      getAudioWindow,
      destroyAudioWindow,
      showRecordingPill,
      hideRecordingPill,
      transcribe,
      keyboardHook: {
        start: keyboardStart,
        stop: keyboardStop,
      },
      isAgentModeEnabled,
      getShortcuts: vi.fn(() => ({
        dictation: { action: 'dictation', accelerator: 'Control+Meta', triggerMode: 'hold', status: 'ready' },
        agent: { action: 'agent', accelerator: 'Alt+Meta', triggerMode: 'hold', status: 'ready' },
      })),
    });
  });

  it('begins recording immediately when the hidden audio window is ready', () => {
    session.markAudioWindowReady();

    session.begin('dictation');

    expect(session.isActive()).toBe(true);
    expect(createAudioWindow).toHaveBeenCalled();
    expect(audioWindow.webContents.send).toHaveBeenCalledWith('audio:start-recording');
    expect(showRecordingPill).toHaveBeenCalledWith('dictation');
  });

  it('queues begin until the hidden audio window reports readiness', () => {
    audioWindow = createWindow({ isLoading: true });
    createAudioWindow.mockImplementation(() => audioWindow);
    getAudioWindow.mockImplementation(() => audioWindow);

    session.begin('agent');

    expect(audioWindow.webContents.send).not.toHaveBeenCalledWith('audio:start-recording');
    expect(showRecordingPill).toHaveBeenCalledWith('agent');

    session.markAudioWindowReady();

    expect(audioWindow.webContents.send).toHaveBeenCalledWith('audio:start-recording');
  });

  it('ends recording and resolves with transcribed text and original intent', async () => {
    session.markAudioWindowReady();
    session.begin('agent');

    const resultPromise = session.end();
    await session.complete(new Uint8Array(64));

    await expect(resultPromise).resolves.toEqual({
      text: 'transcribed text',
      intent: 'agent' satisfies RecordingIntent,
    });
    expect(hideRecordingPill).toHaveBeenCalled();
    expect(audioWindow.webContents.send).toHaveBeenCalledWith('audio:stop-recording');
    expect(transcribe).toHaveBeenCalledWith(new Uint8Array(64));
    expect(session.isActive()).toBe(false);
  });

  it('resolves empty WAV payloads to null without transcription', async () => {
    session.markAudioWindowReady();
    session.begin('dictation');

    const resultPromise = session.end();
    await session.complete(new Uint8Array(44));

    await expect(resultPromise).resolves.toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('cancels recording without waiting for transcription', async () => {
    session.markAudioWindowReady();
    session.begin('dictation');

    await expect(session.cancel()).resolves.toBeUndefined();

    expect(hideRecordingPill).toHaveBeenCalled();
    expect(audioWindow.webContents.send).toHaveBeenCalledWith('audio:stop-recording');
    expect(session.isActive()).toBe(false);
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
    onStop();
    session.stopKeyboardHook();

    expect(showRecordingPill).toHaveBeenCalledWith('agent');
    expect(keyboardStop).toHaveBeenCalledTimes(1);
  });
});
