import { describe, expect, test } from 'bun:test';
import { MobileController, type Recorder } from '../controller';
import { defaultSettings, type MobileSettings } from '../settings';

function recorder(permission = Promise.resolve(true)) {
  const calls = { starts: 0, stops: 0 };
  return {
    calls,
    port: {
      requestPermission: () => permission,
      start: async () => { calls.starts++; },
      stop: async () => { calls.stops++; return new Blob(['RIFF-audio'], { type: 'audio/wav' }); },
      discard: async () => {},
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
  test('local dictation never uploads audio', async () => {
    const order: string[] = [];
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
          allowInsecureHTTP: true, transcriptionEndpoint: `http://127.0.0.1:${server.port}/inference` }),
        saveSettings: async value => value,
        transcribeOnDevice: async () => '  Local speech.  ',
      });
      await controller.initialize();
      await controller.startRecording('dictation');
      await controller.stopRecording();
      expect(order).toEqual(['permission']);
      expect(networkCalls).toBe(0);
      expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', transcript: 'Local speech.', error: null });
      controller.clearResults();
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
      const controller = createController(native.port, { ...defaultSettings, allowInsecureHTTP: true, transcriptionEndpoint: `http://127.0.0.1:${server.port}/inference` });
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
      const controller = createController(native.port, { ...defaultSettings, allowInsecureHTTP: true, transcriptionEndpoint: `http://127.0.0.1:${server.port}/inference` });
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

  test('an agent failure preserves the transcript for retry without recording or transcribing again', async () => {
    let uploads = 0;
    let modelCalls = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      if (new URL(request.url).pathname === '/inference') { await request.formData(); uploads++; return Response.json({ text: 'Explain a rainbow.' }); }
      modelCalls++;
      if (modelCalls === 1) return new Response('private diagnostic', { status: 503 });
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'Light refracts in water droplets.' }, finish_reason: 'stop' }] });
    } });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const native = recorder();
      const controller = createController(native.port, { ...defaultSettings, allowInsecureHTTP: true, agentEnabled: true, transcriptionEndpoint: `${base}/inference`, agentEndpoint: `${base}/chat` });
      await controller.initialize();
      await controller.startRecording('agent');
      await controller.stopRecording();
      expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', transcript: 'Explain a rainbow.', response: '' });
      expect(controller.getSnapshot().error).toContain('503');
      expect(controller.getSnapshot().error).not.toContain('private diagnostic');
      controller.retryAgent();
      await when(controller, () => controller.getSnapshot().phase === 'idle');
      expect(controller.getSnapshot()).toMatchObject({ response: 'Light refracts in water droplets.', error: null });
      expect(uploads).toBe(1);
      expect(native.calls.starts).toBe(1);
      expect(modelCalls).toBe(2);
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
      const controller = createController(native.port, { ...defaultSettings, allowInsecureHTTP: true, transcriptionEndpoint: `http://127.0.0.1:${server.port}/inference` });
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
