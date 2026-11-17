import { describe, expect, it } from 'bun:test';
import { createInputEventParser, parseKeyboardDevices } from '../linux-input';

function inputEvent(type: number, code: number, value: number, seconds = 0, micros = 0): Buffer {
  const event = Buffer.alloc(24);
  event.writeBigInt64LE(BigInt(seconds), 0);
  event.writeBigInt64LE(BigInt(micros), 8);
  event.writeUInt16LE(type, 16);
  event.writeUInt16LE(code, 18);
  event.writeInt32LE(value, 20);
  return event;
}

describe('Linux evdev input', () => {
  it('reads only real keyboards from /proc/bus/input/devices', () => {
    const devices = [
      'N: Name="Power Button"\nH: Handlers=kbd event2\nB: EV=3',
      'N: Name="AT Translated Set 2 keyboard"\nH: Handlers=sysrq kbd leds event3\nB: EV=120013',
      'N: Name="Logitech USB Receiver Mouse"\nH: Handlers=mouse0 event5\nB: EV=17',
    ].join('\n\n');

    expect(parseKeyboardDevices(devices)).toEqual(['/dev/input/event3']);
  });

  it('maps key events split across chunks to VK codes, treating repeat as down', () => {
    const keys: Array<[number, boolean]> = [];
    const feed = createInputEventParser((vk, down) => keys.push([vk, down]));
    const stream = Buffer.concat([
      inputEvent(4, 4, 29), // EV_MSC scan code: ignored
      inputEvent(1, 29, 1), // Left Ctrl down
      inputEvent(0, 0, 0), // SYN
      inputEvent(1, 125, 2), // Left Meta repeat
      inputEvent(1, 47, 0), // V up
    ]);

    feed(stream.subarray(0, 30));
    feed(stream.subarray(30, 77));
    feed(stream.subarray(77));

    expect(keys).toEqual([[0xa2, true], [0x5b, true], [0x56, false]]);
  });

  it('reports each key event at its kernel time in milliseconds', () => {
    const times: Array<number | undefined> = [];
    createInputEventParser((_vk, _down, at) => times.push(at))(Buffer.concat([
      inputEvent(1, 29, 1, 1_700_000_000, 250_000),
      inputEvent(1, 29, 0, 1_700_000_000, 530_500),
    ]));
    expect(times).toEqual([1_700_000_000_250, 1_700_000_000_530.5]);
  });
});
