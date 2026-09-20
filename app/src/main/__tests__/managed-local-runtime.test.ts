import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import { createManagedLocalTranscriber } from '../managed-local-runtime';

class FakeUtilityProcess extends EventEmitter {
  readonly sent: unknown[] = [];
  respondToTranscription = true;

  postMessage(message: unknown): void {
    this.sent.push(message);
    if (!message || typeof message !== 'object' || !('kind' in message)) return;
    if (message.kind === 'load') {
      queueMicrotask(() => this.emit('message', { kind: 'ready', loadMilliseconds: 12 }));
    }
    if (message.kind === 'transcribe' && 'requestId' in message && this.respondToTranscription) {
      queueMicrotask(() => this.emit('message', {
        kind: 'result',
        requestId: message.requestId,
        text: 'hello world',
        transcriptionMilliseconds: 8,
      }));
    }
  }

  kill(): boolean {
    this.emit('exit', 0);
    return true;
  }
}

describe('managed local runtime supervision', () => {
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
