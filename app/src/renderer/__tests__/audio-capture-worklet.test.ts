import { describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

type Message = { type: 'audio'; samples: Float32Array } | { type: 'stopped' } | { type: 'overflow' };

/** Runs the real worklet source against a fake audio-thread global at 16 kHz (320-frame batches). */
async function loadProcessor() {
  const sent: Message[] = [];
  class ProcessorBase {
    port = {
      onmessage: null as ((event: { data: { type: string } }) => void) | null,
      postMessage: (message: Message) => { sent.push(message); },
    };
  }
  type Processor = ProcessorBase & { process(inputs: Float32Array[][]): boolean };
  let create: (() => Processor) | undefined;
  runInNewContext(await Bun.file(fileURLToPath(new URL('../audio-capture-worklet.js', import.meta.url))).text(), {
    AudioWorkletProcessor: ProcessorBase,
    sampleRate: 16000,
    Float32Array,
    registerProcessor: (_name: string, Constructor: new () => Processor) => {
      create = () => new Constructor();
    },
  });
  if (!create) throw new Error('processor was not registered');
  return { processor: create(), sent };
}

describe('capture audio-thread boundary', () => {
  it('batches input and flushes its remaining samples before acknowledging stop exactly once', async () => {
    const { processor, sent } = await loadProcessor();
    for (let block = 0; block < 3; block++) processor.process([[new Float32Array(128).fill(0.25)]]);
    expect(sent).toHaveLength(1);
    processor.port.onmessage?.({ data: { type: 'stop' } });
    expect(sent.map(message => message.type)).toEqual(['audio', 'audio', 'stopped']);
    expect(sent.flatMap(message => message.type === 'audio' ? [...message.samples] : []))
      .toEqual([...new Float32Array(384).fill(0.25)]);
    processor.port.onmessage?.({ data: { type: 'stop' } });
    expect(processor.process([[new Float32Array(128)]])).toBe(false);
    expect(sent).toHaveLength(3);
  });

  it('stops with overflow once uncredited batches hit the bound, and keeps going while credits return', async () => {
    const { processor, sent } = await loadProcessor();
    const block = () => processor.process([[new Float32Array(320).fill(0.5)]]);
    // Credits flowing back: far more batches than the bound pass without overflow.
    for (let index = 0; index < 600; index += 1) {
      expect(block()).toBe(true);
      processor.port.onmessage?.({ data: { type: 'credit' } });
    }
    expect(sent.every((message) => message.type === 'audio')).toBe(true);

    // Credits stop (renderer or main stalled): the bound is finite and ends capture.
    let blocks = 0;
    while (block()) blocks += 1;
    expect(blocks).toBe(250);
    expect(sent.at(-1)?.type).toBe('overflow');
    expect(sent.filter((message) => message.type === 'audio')).toHaveLength(600 + 250);
    processor.port.onmessage?.({ data: { type: 'stop' } });
    expect(sent.at(-1)?.type).toBe('overflow');
  });
});
