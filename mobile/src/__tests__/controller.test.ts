import { describe, expect, test } from 'bun:test';
import { MobileController, RecordingInterruptedError, type Recorder } from '../controller';
import { defaultSettings, type MobileSettings } from '../settings';
import { chatReply } from './model-stream';

function recorder(permission = Promise.resolve(true)) {
  const calls = { starts: 0, stops: 0, discards: 0 };
  return {
    calls,
    port: {
      requestPermission: () => permission,
      start: async () => { calls.starts++; },
      stop: async (onClosed: () => void) => { calls.stops++; onClosed(); return new Blob(['RIFF-audio'], { type: 'audio/wav' }); },
      discard: async () => { calls.discards++; },
    } satisfies Recorder,
  };
}

function createController(native: Recorder, settings: MobileSettings = defaultSettings) {
  return new MobileController({ recorder: native, fetch,
    loadSettings: async () => settings,
    saveSettings: async value => value,
  });
}

function when(controller: MobileController, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise(resolve => {
    const unsubscribe = controller.subscribe(() => { if (predicate()) { unsubscribe(); resolve(); } });
  });
}

describe('mobile command lifecycle', () => {
  test('a capture failure sounds after cleanup, while a cancelled start stays quiet', async () => {
    const permission = Promise.withResolvers<boolean>();
    const native = recorder(permission.promise);
    const cueAfterCleanup: number[] = [];
    const controller = createController({ ...native.port,
      playCue: async cue => { if (cue === 'error') cueAfterCleanup.push(native.calls.discards); },
    });
    await controller.initialize();
    const start = controller.startRecording('dictation');
    controller.cancel();
    permission.resolve(false);
    await start;
    expect(cueAfterCleanup).toEqual([]);
    await controller.startRecording('dictation');
    expect(cueAfterCleanup).toEqual([2]);
    expect(controller.getSnapshot().error).toContain('Microphone access is denied');
  });

  test('an interruption while capture resumes discards audio without an Error sound', async () => {
    const native = recorder();
    const resuming = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    let cues = 0;
    const controller = createController({ ...native.port,
      start: () => { resuming.resolve(); return resumed.promise; },
      playCue: async () => { cues++; },
    });
    await controller.initialize();
    const start = controller.startRecording('dictation');
    await resuming.promise;
    controller.recordingInterrupted();
    resumed.resolve();
    await start;
    expect(native.calls.discards).toBe(1);
    expect(cues).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', error: 'Recording was interrupted. No audio was sent. Record again.' });
  });

  test('an interruption detected at file closure discards partial audio without a cue or transcription', async () => {
    const native = recorder();
    let cues = 0;
    let decodes = 0;
    const controller = new MobileController({
      recorder: { ...native.port,
        stop: async () => { throw new RecordingInterruptedError(); },
        playCue: async () => { cues++; },
      },
      fetch,
      loadSettings: async () => ({ ...defaultSettings, transcriptionSource: 'on-device' }),
      saveSettings: async value => value,
      transcribeOnDevice: async () => { decodes++; return 'Partial audio.'; },
    });
    await controller.initialize();
    await controller.startRecording('dictation');
    await controller.stopRecording();
    expect(native.calls.discards).toBe(1);
    expect(cues).toBe(0);
    expect(decodes).toBe(0);
    expect(controller.getSnapshot().error).toContain('Recording was interrupted');
  });

  test('an encoder error while Stop is pending discards partial audio without a Stop cue', async () => {
    const native = recorder();
    const closing = Promise.withResolvers<void>();
    const file = Promise.withResolvers<Blob>();
    const cues: string[] = [];
    let decodes = 0;
    const controller = new MobileController({
      recorder: { ...native.port,
        stop: async onClosed => {
          closing.resolve();
          const audio = await file.promise;
          onClosed();
          return audio;
        },
        playCue: async cue => { cues.push(cue); },
      },
      fetch,
      loadSettings: async () => ({ ...defaultSettings, transcriptionSource: 'on-device' }),
      saveSettings: async value => value,
      transcribeOnDevice: async () => { decodes++; return 'Partial audio.'; },
    });
    await controller.initialize();
    await controller.startRecording('dictation');
    const stopping = controller.stopRecording();
    await closing.promise;
    controller.recordingInterrupted(true);
    file.resolve(new Blob(['partial']));
    await stopping;
    expect(cues).toEqual(['error']);
    expect(native.calls.discards).toBe(1);
    expect(decodes).toBe(0);
    expect(controller.getSnapshot().error).toContain('Recording failed');
  });

  test('an encoder failure signals Error after discarding the recording', async () => {
    const native = recorder();
    const cues: number[] = [];
    const controller = createController({ ...native.port, playCue: async () => { cues.push(native.calls.discards); } });
    await controller.initialize();
    await controller.startRecording('dictation');
    controller.recordingInterrupted(true);
    await when(controller, () => controller.getSnapshot().phase === 'idle');
    expect(cues).toEqual([1]);
    expect(native.calls.stops).toBe(0);
  });

  test('saving settings leaves the resting Home status intact', async () => {
    const controller = createController(recorder().port);
    await controller.initialize();
    const status = controller.getSnapshot().status;
    await controller.saveSettings({ ...defaultSettings, customInstructions: 'Be brief.' });
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', status });
  });
  test('transcription starts while Stop sounds and the audio route stays open until the cue finishes', async () => {
    const sound = Promise.withResolvers<void>();
    const decoding = Promise.withResolvers<void>();
    const native = recorder();
    const controller = new MobileController({
      recorder: { ...native.port, playCue: cue => {
        expect(cue).toBe('stop');
        expect(native.calls.stops).toBe(1);
        return sound.promise;
      } },
      fetch,
      loadSettings: async () => ({ ...defaultSettings, transcriptionSource: 'on-device' }),
      saveSettings: async value => value,
      transcribeOnDevice: async () => { decoding.resolve(); return 'A complete recording.'; },
    });
    await controller.initialize();
    await controller.startRecording('dictation');
    const stopped = controller.stopRecording();
    await decoding.promise;
    expect(native.calls.discards).toBe(0);
    sound.resolve();
    await stopped;
    expect(native.calls.discards).toBe(1);
    expect(controller.getSnapshot().transcript).toBe('A complete recording.');
  });

  test('a closed capture with unreadable audio plays Stop before Error', async () => {
    const native = recorder();
    const cues: string[] = [];
    const controller = createController({ ...native.port,
      stop: async onClosed => { onClosed(); throw new Error('Could not read the recording.'); },
      playCue: async cue => { cues.push(cue); },
    });
    await controller.initialize();
    await controller.startRecording('dictation');
    await controller.stopRecording();
    expect(cues).toEqual(['stop', 'error']);
    expect(controller.getSnapshot().error).toBe('Could not read the recording.');
  });

  test('local dictation never uploads audio', async () => {
    const order: string[] = [];
    let selectedLanguage: string | undefined;
    let networkCalls = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
      networkCalls++;
      return Response.json({ text: 'Unexpected remote result.' });
    } });
    try {
      const native = recorder();
      const controller = new MobileController({ recorder: { ...native.port,
        requestPermission: async () => { order.push('permission'); return true; },
      },
        fetch,
        loadSettings: async () => ({ ...defaultSettings, transcriptionSource: 'on-device',
          language: 'en',
          allowInsecureHTTP: true, transcriptionEndpoint: `http://127.0.0.1:${server.port}/inference` }),
        saveSettings: async value => value,
        transcribeOnDevice: async (_signal, language) => { selectedLanguage = language; return '  Local speech.  '; },
      });
      await controller.initialize();
      await controller.startRecording('dictation');
      await controller.stopRecording();
      expect(order).toEqual(['permission']);
      expect(networkCalls).toBe(0);
      expect(selectedLanguage).toBe('en');
      expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', transcript: 'Local speech.', error: null });
      await controller.clearResults();
      expect(controller.getSnapshot().transcript).toBe('');
    } finally { await server.stop(true); }
  });

  test('cancelled native inference retains its recording until completion and ignores the late text', async () => {
    const result = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    let discarded = false;
    const native = recorder();
    const controller = new MobileController({ recorder: { ...native.port, discard: async () => { discarded = true; } }, fetch,
      loadSettings: async () => ({ ...defaultSettings, transcriptionSource: 'on-device' }),
      saveSettings: async value => value,
      transcribeOnDevice: async () => { entered.resolve(); return result.promise; },
    });
    await controller.initialize();
    await controller.startRecording('dictation');
    const pending = controller.stopRecording();
    await entered.promise;
    controller.cancel();
    await controller.startRecording('dictation');
    expect(native.calls.starts).toBe(1);
    expect(discarded).toBe(false);
    result.resolve('A cancelled transcript.');
    await pending;
    expect(discarded).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', transcript: '', error: null });
  });

  test('a cancelled permission request cannot start a late recording or overlap a new one', async () => {
    const permission = Promise.withResolvers<boolean>();
    const native = recorder(permission.promise);
    const controller = createController(native.port);
    await controller.initialize();
    const pending = controller.startRecording('dictation');
    controller.cancel();
    await controller.startRecording('dictation');
    permission.resolve(true);
    await pending;
    expect(native.calls.starts).toBe(0);
    expect(controller.getSnapshot().phase).toBe('idle');
    await controller.startRecording('dictation');
    expect(controller.getSnapshot().phase).toBe('recording');
    expect(native.calls.starts).toBe(1);
    controller.cancel();
    await when(controller, () => controller.getSnapshot().phase === 'idle');
  });

  test('dictation works with Agent Mode disabled and a double stop sends audio only once', async () => {
    let uploads = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      await request.formData(); uploads++;
      return Response.json({ text: 'Hello from dictation.' });
    } });
    try {
      const native = recorder();
      const controller = createController(native.port, { ...defaultSettings, transcriptionProvider: 'custom-open-ai-compatible', agentProvider: 'openai-compatible', allowInsecureHTTP: true, transcriptionEndpoint: `http://127.0.0.1:${server.port}/inference` });
      await controller.initialize();
      await controller.startRecording('dictation');
      const finishing = controller.stopRecording();
      await controller.stopRecording();
      await expect(controller.saveSettings(defaultSettings)).rejects.toThrow('Wait for the current command');
      await finishing;
      expect(uploads).toBe(1);
      expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', transcript: 'Hello from dictation.', response: '', error: null });
    } finally { await server.stop(true); }
  });

  test('cancelling an upload prevents its late transcript from replacing the current result', async () => {
    const received = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Response>();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { received.resolve(); return reply.promise; } });
    try {
      const native = recorder();
      const controller = createController(native.port, { ...defaultSettings, transcriptionProvider: 'custom-open-ai-compatible', agentProvider: 'openai-compatible', allowInsecureHTTP: true, transcriptionEndpoint: `http://127.0.0.1:${server.port}/inference` });
      await controller.initialize();
      await controller.startRecording('dictation');
      const finishing = controller.stopRecording();
      await received.promise;
      controller.cancel();
      reply.resolve(Response.json({ text: 'This is stale.' }));
      await finishing;
      expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', transcript: '', error: null });
      await controller.startRecording('dictation');
      expect(controller.getSnapshot().phase).toBe('recording');
      controller.cancel();
      await when(controller, () => controller.getSnapshot().phase === 'idle');
    } finally { reply.resolve(Response.json({ text: '' })); await server.stop(true); }
  });

  test('agent work releases audio before requesting the model and preserves a failed command for retry', async () => {
    let uploads = 0;
    let modelCalls = 0;
    const native = recorder();
    const cleanupBeforeModel: number[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      if (new URL(request.url).pathname === '/inference') { await request.formData(); uploads++; return Response.json({ text: 'Explain a rainbow.' }); }
      modelCalls++;
      cleanupBeforeModel.push(native.calls.discards);
      // A non-retryable status: the SDK retries 5xx itself before the run fails.
      if (modelCalls === 1) return new Response('private diagnostic', { status: 400 });
      return chatReply('Light refracts in water droplets.');
    } });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const controller = createController(native.port, { ...defaultSettings, transcriptionProvider: 'custom-open-ai-compatible', agentProvider: 'openai-compatible', allowInsecureHTTP: true, agentEnabled: true, transcriptionEndpoint: `${base}/inference`, agentEndpoint: `${base}/chat` });
      await controller.initialize();
      await controller.startRecording('agent');
      await controller.stopRecording();
      expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', transcript: 'Explain a rainbow.', response: '' });
      expect(controller.getSnapshot().error).toContain('400');
      expect(controller.getSnapshot().error).not.toContain('private diagnostic');
      controller.retryAgent();
      await when(controller, () => controller.getSnapshot().phase === 'idle');
      expect(controller.getSnapshot()).toMatchObject({ response: 'Light refracts in water droplets.', error: null });
      expect(uploads).toBe(1);
      expect(native.calls.starts).toBe(1);
      expect(modelCalls).toBe(2);
      expect(cleanupBeforeModel[0]).toBeGreaterThan(0);
    } finally { await server.stop(true); }
  });

  // The answer on screen is the conversation an Agent recording replies to; Clear is the way back to a fresh command.
  test('an agent recording replies to the answer on screen until it is cleared', async () => {
    const spoken = ['What is the weather?', 'Pune.', 'Tell me a joke.'];
    const bodies: string[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      if (new URL(request.url).pathname === '/inference') { await request.formData(); return Response.json({ text: spoken.shift() }); }
      bodies.push(await request.text());
      return chatReply(bodies.length === 1 ? 'Which city?' : 'Done.');
    } });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const controller = createController(recorder().port, { ...defaultSettings, transcriptionProvider: 'custom-open-ai-compatible', agentProvider: 'openai-compatible', allowInsecureHTTP: true, agentEnabled: true, transcriptionEndpoint: `${base}/inference`, agentEndpoint: `${base}/chat` });
      await controller.initialize();
      const ask = async () => { await controller.startRecording('agent'); await controller.stopRecording(); };
      await ask();
      expect(controller.getSnapshot()).toMatchObject({ response: 'Which city?', canReply: true });
      await ask();
      expect(bodies[1]).toContain('Which city?');
      expect(controller.getSnapshot()).toMatchObject({ turns: [{ command: 'What is the weather?', response: 'Which city?' }], transcript: 'Pune.', response: 'Done.' });
      await controller.clearResults();
      expect(controller.getSnapshot()).toMatchObject({ canReply: false, turns: [] });
      await ask();
      expect(bodies[2]).not.toContain('Which city?');
      expect(bodies[2]).not.toContain('Pune.');
    } finally { await server.stop(true); }
  });

  test('unreadable saved settings cannot be silently overwritten or used to start recording', async () => {
    const native = recorder();
    let writes = 0;
    const controller = new MobileController({ recorder: native.port, fetch,
      loadSettings: async () => { throw new Error('SecureStore unavailable'); },
      saveSettings: async settings => { writes++; return settings; },
    });
    await controller.initialize();
    await controller.startRecording('dictation');
    await expect(controller.saveSettings(defaultSettings)).rejects.toThrow();
    expect(native.calls.starts).toBe(0);
    expect(writes).toBe(0);
    expect(controller.getSnapshot().error).toContain('have not been replaced');
    await controller.resetSettings();
    expect(writes).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', settings: defaultSettings, error: null });
  });

  test('a failed replacement recording cannot leave an older command available for agent retry', async () => {
    let uploads = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
      uploads++;
      return uploads === 1 ? Response.json({ text: 'An earlier command.' }) : new Response(null, { status: 503 });
    } });
    try {
      const native = recorder();
      const controller = createController(native.port, { ...defaultSettings, transcriptionProvider: 'custom-open-ai-compatible', agentProvider: 'openai-compatible', allowInsecureHTTP: true, transcriptionEndpoint: `http://127.0.0.1:${server.port}/inference` });
      await controller.initialize();
      await controller.startRecording('dictation');
      await controller.stopRecording();
      expect(controller.getSnapshot().transcript).toBe('An earlier command.');
      await controller.startRecording('dictation');
      await controller.stopRecording();
      expect(controller.getSnapshot().error).toContain('503');
      expect(controller.getSnapshot().transcript).toBe('');
    } finally { await server.stop(true); }
  });
});

test('Stop during interruption cleanup never sends the retained audio', async () => {
  const cleanup = Promise.withResolvers<void>();
  const native = recorder();
  const controller = createController({ ...native.port, discard: () => cleanup.promise });
  await controller.initialize();
  await controller.startRecording('dictation');
  controller.recordingInterrupted();
  await controller.stopRecording();
  expect(native.calls.stops).toBe(0);
  cleanup.resolve();
});
