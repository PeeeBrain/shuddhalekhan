import { describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { createManagedLocalTranscriber } from '../managed-local-runtime';

class FakeUtilityProcess extends EventEmitter {
  readonly sent: unknown[] = [];
  respondToLoad = true;
  respondToTranscription = true;

  postMessage(message: unknown): void {
    this.sent.push(message);
    this.emit('sent', message);
    if (!message || typeof message !== 'object' || !('kind' in message)) return;
    if (message.kind === 'load' && this.respondToLoad) {
      queueMicrotask(() => this.emit('message', { kind: 'ready' }));
    }
    if (message.kind === 'transcribe' && 'requestId' in message && this.respondToTranscription) {
      queueMicrotask(() => this.emit('message', {
        kind: 'result',
        requestId: message.requestId,
        text: 'hello world',
      }));
    }
  }

  kill(): boolean {
    this.emit('exit', 0);
    return true;
  }
}

describe('managed local runtime supervision', () => {
  it('does not spawn a stale worker when shutdown happens before model resolution', async () => {
    let resolvePath!: (path: string) => void;
    const startProcess = mock(() => new FakeUtilityProcess());
    const transcriber = createManagedLocalTranscriber({
      getModelPath: () => new Promise<string>(resolve => { resolvePath = resolve; }), startProcess,
    });
    const startup = transcriber.warmup();
    await transcriber.shutdown();
    resolvePath('model');
    await expect(startup).rejects.toThrow('stopped');
    expect(startProcess).not.toHaveBeenCalled();
  });
  it('ignores startup messages from a retired worker while its replacement is loading', async () => {
    const old = new FakeUtilityProcess();
    const replacement = new FakeUtilityProcess();
    replacement.respondToLoad = false;
    const replacementLoad = new Promise<void>(resolve => replacement.once('sent', () => resolve()));
    const exited = mock();
    replacement.on('exit', exited);
    const children = [old, replacement];
    const transcriber = createManagedLocalTranscriber({ getModelPath: async () => 'model', startProcess: () => {
      const child = children.shift();
      if (!child) throw new Error('Unexpected worker restart');
      return child;
    } });
    try {
      await transcriber.warmup();
      await transcriber.shutdown();
      const startup = transcriber.warmup();
      await replacementLoad;
      old.emit('message', { kind: 'ready' });
      old.emit('message', { kind: 'load-error', message: 'Retired worker failed' });
      expect(exited).not.toHaveBeenCalled();
      replacement.emit('message', { kind: 'ready' });
      await startup;
      expect(await transcriber.transcribe({ audio: new Uint8Array([1]), recognition: {
        language: 'en', task: 'transcribe', dictionary: [], removeFillerWords: false,
      } })).toBe('hello world');
    } finally { await transcriber.shutdown(); }
  });

  it('shares one startup across concurrent callers', async () => {
    const child = new FakeUtilityProcess();
    let resolveModelPath!: (path: string) => void;
    const getModelPath = mock(() => new Promise<string>((resolve) => { resolveModelPath = resolve; }));
    const transcriber = createManagedLocalTranscriber({ getModelPath, startProcess: () => child });

    const first = transcriber.warmup();
    const second = transcriber.warmup();
    expect(getModelPath).toHaveBeenCalledTimes(1);
    resolveModelPath('C:\\models\\parakeet');

    await Promise.all([first, second]);
    expect(child.sent.filter((message) => (
      message && typeof message === 'object' && 'kind' in message && message.kind === 'load'
    ))).toHaveLength(1);
    await transcriber.shutdown();
  });

  it('restarts after model loading times out', async () => {
    const children: FakeUtilityProcess[] = [];
    const transcriber = createManagedLocalTranscriber({
      getModelPath: async () => 'C:\\models\\parakeet',
      loadTimeoutMs: 1,
      startProcess: () => {
        const child = new FakeUtilityProcess();
        child.respondToLoad = children.length > 0;
        children.push(child);
        return child;
      },
    });

    await expect(transcriber.warmup()).rejects.toThrow('timed out');
    await transcriber.warmup();
    expect(children).toHaveLength(2);
    await transcriber.shutdown();
  });

  it('restarts after transcription times out', async () => {
    const children: FakeUtilityProcess[] = [];
    const transcriber = createManagedLocalTranscriber({
      getModelPath: async () => 'C:\\models\\parakeet',
      transcriptionTimeoutMs: 1,
      startProcess: () => {
        const child = new FakeUtilityProcess();
        child.respondToTranscription = children.length > 0;
        children.push(child);
        return child;
      },
    });

    await expect(transcriber.transcribe({
      audio: new Uint8Array([1]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    })).rejects.toThrow('timed out');
    expect(await transcriber.transcribe({
      audio: new Uint8Array([2]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    })).toBe('hello world');
    expect(children).toHaveLength(2);
    await transcriber.shutdown();
  });

  it('loads once and transcribes through structured utility-process messages', async () => {
    const child = new FakeUtilityProcess();
    const transcriber = createManagedLocalTranscriber({
      getModelPath: async () => 'C:\\models\\parakeet',
      startProcess: () => child,
    });

    const text = await transcriber.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    });

    expect(text).toBe('hello world');
    expect(child.sent.map((message) => (
      message && typeof message === 'object' && 'kind' in message ? message.kind : null
    ))).toEqual(['load', 'transcribe']);
    await transcriber.shutdown();
  });

  it('pins vocabulary before async startup and transports it to the native worker', async () => {
    const child = new FakeUtilityProcess();
    const transcriber = createManagedLocalTranscriber({ getModelPath: async () => 'model', startProcess: () => child });
    const recognition = { language: 'en', task: 'transcribe' as const, dictionary: ['Shuddhalekhan'], removeFillerWords: false };
    try {
      const result = transcriber.transcribe({ audio: new Uint8Array([1]), recognition });
      recognition.dictionary[0] = 'Changed after recording';
      await result;
      expect(child.sent.find(message => message && typeof message === 'object' && 'kind' in message && message.kind === 'transcribe'))
        .toMatchObject({ dictionary: ['Shuddhalekhan'] });
    } finally { await transcriber.shutdown(); }
  });

  it('returns at once on abort, drains the running decode, and never sends queued aborted work', async () => {
    const child = new FakeUtilityProcess();
    child.respondToTranscription = false;
    const transcriber = createManagedLocalTranscriber({ getModelPath: async () => 'model', startProcess: () => child });
    const recognition = { language: 'en', task: 'transcribe' as const, dictionary: [], removeFillerWords: false };
    const transcribes = () => child.sent.filter((message): message is { requestId: string } =>
      !!message && typeof message === 'object' && 'kind' in message && message.kind === 'transcribe');
    try {
      const first = new AbortController();
      const running = transcriber.transcribe({ audio: new Uint8Array([1]), recognition, signal: first.signal });
      while (!transcribes().length) await Promise.resolve();
      const queued = new AbortController();
      const skipped = transcriber.transcribe({ audio: new Uint8Array([2]), recognition, signal: queued.signal });
      const next = transcriber.transcribe({ audio: new Uint8Array([3]), recognition });
      first.abort();
      queued.abort();
      await expect(running).rejects.toThrow();
      await expect(skipped).rejects.toThrow();
      expect(transcribes()).toHaveLength(1);

      child.emit('message', { kind: 'result', requestId: transcribes()[0].requestId, text: 'late' });
      while (transcribes().length < 2) await Promise.resolve();
      child.emit('message', { kind: 'result', requestId: transcribes()[1].requestId, text: 'next' });
      expect(await next).toBe('next');
      expect(transcribes()).toHaveLength(2);
    } finally { await transcriber.shutdown(); }
  });

  it('rejects work on a crash and starts a fresh process for the next request', async () => {
    const children: FakeUtilityProcess[] = [];
    const transcriber = createManagedLocalTranscriber({
      getModelPath: async () => 'C:\\models\\parakeet',
      startProcess: () => {
        const child = new FakeUtilityProcess();
        child.respondToTranscription = children.length > 0;
        children.push(child);
        return child;
      },
    });

    const first = transcriber.transcribe({
      audio: new Uint8Array([1]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    });
    while (!children[0]?.sent.some((message) => (
      message && typeof message === 'object' && 'kind' in message && message.kind === 'transcribe'
    ))) await Promise.resolve();
    children[0]?.emit('exit', 1);
    await expect(first).rejects.toThrow('stopped unexpectedly');

    expect(await transcriber.transcribe({
      audio: new Uint8Array([2]),
      recognition: { language: 'auto', task: 'transcribe', dictionary: [], removeFillerWords: false },
    })).toBe('hello world');
    expect(children).toHaveLength(2);
  });
});
