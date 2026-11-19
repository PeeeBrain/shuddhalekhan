import { describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

type Message = { type: 'audio'; samples: Float32Array } | { type: 'started'; samples: Float32Array; late: number }
  | { type: 'stopped' } | { type: 'overflow' };
type Command = { type: 'start'; preRollFrames: number; pressFrame?: number } | { type: 'stop' } | { type: 'credit' };

/** Runs the real worklet source against a fake audio-thread global at 16 kHz (320-frame batches). */
async function loadProcessor(preRollFrames = 0) {
  const sent: Message[] = [];
  class ProcessorBase {
    port = {
      onmessage: null as ((event: { data: Command }) => void) | null,
      // Transfers detach the sender's buffers, as a real MessagePort does.
      postMessage: (message: Message, transfer: ArrayBuffer[] = []) => { sent.push(structuredClone(message, { transfer })); },
    };
  }
  type Processor = ProcessorBase & { process(inputs: Float32Array[][]): boolean };
  type Options = { processorOptions: { preRollFrames: number } };
  let create: (() => Processor) | undefined;
  const scope = {
    AudioWorkletProcessor: ProcessorBase,
    sampleRate: 16000,
    currentFrame: 0,
    Float32Array,
    registerProcessor: (_name: string, Constructor: new (options: Options) => Processor) => {
      create = () => new Constructor({ processorOptions: { preRollFrames } });
    },
  };
  runInNewContext(await Bun.file(fileURLToPath(new URL('../audio-capture-worklet.js', import.meta.url))).text(), scope);
  if (!create) throw new Error('processor was not registered');
  const processor = create();
  const command = (data: Command) => processor.port.onmessage?.({ data });
  return { processor, sent, command, scope };
}

const ramp = (from: number, length: number) => Float32Array.from({ length }, (_, index) => from + index);

describe('capture audio-thread boundary', () => {
  it('idles silently on a bounded ring, hands its newest frames to start, and returns to idle on stop', async () => {
    const { processor, sent, command } = await loadProcessor(200);
    for (let block = 0; block < 3; block++) expect(processor.process([[ramp(block * 128, 128)]])).toBe(true);
    expect(sent).toHaveLength(0);

    command({ type: 'start', preRollFrames: 150 });
    expect(sent).toEqual([{ type: 'started', samples: ramp(384 - 150, 150), late: 0 }]);
    for (let block = 0; block < 3; block++) processor.process([[new Float32Array(128).fill(0.25)]]);
    command({ type: 'stop' });
    expect(sent.map(message => message.type)).toEqual(['started', 'audio', 'audio', 'stopped']);
    expect(sent.flatMap(message => message.type === 'audio' ? [...message.samples] : []))
      .toEqual([...new Float32Array(384).fill(0.25)]);
    command({ type: 'stop' });
    expect(sent).toHaveLength(4);

    // Idle again: the recording is not in the ring, only what came after it.
    expect(processor.process([[ramp(1000, 128)]])).toBe(true);
    command({ type: 'start', preRollFrames: 200 });
    expect(sent.at(-1)).toEqual({ type: 'started', samples: ramp(1000, 128), late: 0 });
  });

  it('hands over only ring frames heard before the press; later ones open the capture', async () => {
    const { processor, sent, command, scope } = await loadProcessor(400);
    for (let block = 0; block < 3; block++) processor.process([[ramp(block * 128, 128)]]);
    scope.currentFrame = 384;

    // The start reached the audio thread 100 frames after the press; main must hear of them to place the cue.
    command({ type: 'start', preRollFrames: 300, pressFrame: 284 });
    expect(sent).toEqual([{ type: 'started', samples: ramp(84, 200), late: 100 }]);
    processor.process([[ramp(384, 220)]]);
    expect(sent.at(-1)).toEqual({ type: 'audio', samples: ramp(284, 320) });
  });

  it('keeps frames heard after the press when a cue allows no pre-roll', async () => {
    const { processor, sent, command, scope } = await loadProcessor(400);
    for (let block = 0; block < 3; block++) processor.process([[ramp(block * 128, 128)]]);
    scope.currentFrame = 384;

    command({ type: 'start', preRollFrames: 0, pressFrame: 284 });
    expect(sent).toEqual([{ type: 'started', samples: new Float32Array(0), late: 100 }]);
    processor.process([[ramp(384, 220)]]);
    expect(sent.at(-1)).toEqual({ type: 'audio', samples: ramp(284, 320) });
  });

  it('stops with overflow once uncredited batches hit the bound, and keeps going while credits return', async () => {
    const { processor, sent, command } = await loadProcessor();
    command({ type: 'start', preRollFrames: 0 });
    const block = () => processor.process([[new Float32Array(320).fill(0.5)]]);
    // Credits flowing back: far more batches than the bound pass without overflow.
    for (let index = 0; index < 600; index += 1) {
      expect(block()).toBe(true);
      command({ type: 'credit' });
    }
    const audio = () => sent.filter((message) => message.type === 'audio');
    expect(audio()).toHaveLength(600);

    // Credits stop (renderer or main stalled): the bound is finite and ends capture for good.
    let blocks = 0;
    while (block()) blocks += 1;
    expect(blocks).toBe(250);
    expect(sent.at(-1)?.type).toBe('overflow');
    expect(audio()).toHaveLength(600 + 250);
    command({ type: 'stop' });
    command({ type: 'start', preRollFrames: 0 });
    expect(sent.at(-1)?.type).toBe('overflow');
  });
});
