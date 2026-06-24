import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { installElectronMock } from '../../test/electron-mock';
import type { AudioStream } from '../audio-stream';

const vi = { fn: mock };
let AudioStreamCtor: typeof AudioStream;

installElectronMock();
mock.module('../native/keyboard', () => ({
  keyboardHook: { start: vi.fn(), stop: vi.fn() },
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

describe('AudioStream adapter', () => {
  let audioWindow: ReturnType<typeof createWindow>;
  let createAudioWindow: ReturnType<typeof vi.fn>;
  let getAudioWindow: ReturnType<typeof vi.fn>;
  let destroyAudioWindow: ReturnType<typeof vi.fn>;
  let stream: AudioStream;

  afterAll(() => {
    mock.restore();
  });

  beforeEach(async () => {
    ({ AudioStream: AudioStreamCtor } = await import(`../audio-stream?test=${Date.now()}-${Math.random()}`));
    audioWindow = createWindow();
    createAudioWindow = vi.fn(() => audioWindow);
    getAudioWindow = vi.fn(() => audioWindow);
    destroyAudioWindow = vi.fn();
    stream = new AudioStreamCtor({ createAudioWindow, getAudioWindow, destroyAudioWindow });
  });

  it('reuses the prepared stream across multiple begin/end cycles without re-creating the window', () => {
    stream.prepare();
    stream.markReady();

    stream.beginCapture();
    stream.endCapture();

    stream.beginCapture();
    stream.endCapture();

    expect(createAudioWindow).toHaveBeenCalledTimes(1);
    const startCalls = (audioWindow.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([channel]: [string, ...unknown[]]) => channel === 'audio:start-recording'
    );
    const stopCalls = (audioWindow.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([channel]: [string, ...unknown[]]) => channel === 'audio:stop-recording'
    );
    expect(startCalls).toHaveLength(2);
    expect(stopCalls).toHaveLength(2);
  });

  it('recreates the stream on selected-device change and resets readiness until the renderer reports ready again', () => {
    stream.prepare();
    stream.markReady();
    expect(stream.isStreamReady()).toBe(true);

    stream.setSelectedDevice('mic-2');

    expect(audioWindow.webContents.send).toHaveBeenCalledWith('audio:recreate-stream', 'mic-2');
    expect(stream.isStreamReady()).toBe(false);

    stream.beginCapture();
    expect(audioWindow.webContents.send).not.toHaveBeenCalledWith('audio:start-recording');

    stream.markReady();
    expect(stream.isStreamReady()).toBe(true);
    stream.beginCapture();
    expect(audioWindow.webContents.send).toHaveBeenCalledWith('audio:start-recording');
  });

  it('resets readiness after a crash and re-prepares so the next recording recovers cleanly', () => {
    stream.prepare();
    stream.markReady();
    expect(stream.isStreamReady()).toBe(true);

    stream.markCrashed('render-process-gone');

    expect(stream.isStreamReady()).toBe(false);
    stream.beginCapture();
    expect(audioWindow.webContents.send).not.toHaveBeenCalledWith('audio:start-recording');

    stream.prepare();
    expect(createAudioWindow).toHaveBeenCalledTimes(2);

    stream.markReady();
    stream.beginCapture();
    expect(audioWindow.webContents.send).toHaveBeenCalledWith('audio:start-recording');
  });

  it('queues a begin issued while the stream is warming and flushes it when the renderer reports ready', () => {
    stream.prepare();

    stream.beginCapture();
    expect(audioWindow.webContents.send).not.toHaveBeenCalledWith('audio:start-recording');

    stream.markReady();
    expect(audioWindow.webContents.send).toHaveBeenCalledWith('audio:start-recording');
  });

  it('clears the queued begin when capture is cancelled before the stream is ready', () => {
    stream.prepare();

    stream.beginCapture();
    stream.cancelCapture();
    expect(audioWindow.webContents.send).not.toHaveBeenCalledWith('audio:start-recording');

    stream.markReady();
    expect(audioWindow.webContents.send).not.toHaveBeenCalledWith('audio:start-recording');
  });
});
