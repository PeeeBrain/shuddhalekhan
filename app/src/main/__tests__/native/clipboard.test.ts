import { beforeEach, describe, expect, it, mock } from 'bun:test';

const vi = { fn: mock };
let sendInputResult = 4;
let lastErrorCode = 0;

const funcs = new Map<string, ReturnType<typeof vi.fn>>();

mock.module('koffi', () => ({
  default: {
    load: vi.fn(() => ({
    func: vi.fn((signature: string) => {
      const name = signature.split('(')[0].trim().split(' ').pop() ?? signature;
      const fn = vi.fn((..._args: unknown[]) => {
          if (name === 'SendInput') {
            return sendInputResult;
          }
          if (name === 'GetLastError') {
            return lastErrorCode;
          }
          return 0;
        });
        funcs.set(name, fn);
        return fn;
      }),
    })),
    struct: vi.fn(() => ({})),
    proto: vi.fn(() => ({})),
    pointer: vi.fn(() => ({})),
    register: vi.fn(),
    unregister: vi.fn(),
    decode: vi.fn(),
  },
}));

import type {
  simulatePaste as SimulatePaste,
} from '../../native/clipboard';

// SendInput dispatch; native X11 dispatch has an isolated-server integration test.
describe.skipIf(process.platform !== 'win32')('native clipboard paste dispatch', () => {
  let simulatePaste: typeof SimulatePaste;

  beforeEach(async () => {
    sendInputResult = 4;
    lastErrorCode = 0;
    funcs.clear();
    const mod = await import(`../../native/clipboard?test=${Date.now()}-${Math.random()}`);
    simulatePaste = mod.simulatePaste;
  });

  it('encodes ctrl-v as Win32 INPUT records with key releases', () => {
    simulatePaste();
    const expected = Buffer.alloc(160);
    for (const [index, vk, flags] of [[0, 0x11, 0], [1, 0x56, 0], [2, 0x56, 2], [3, 0x11, 2]]) {
      expected.writeUInt32LE(1, index * 40);
      expected.writeUInt16LE(vk, index * 40 + 8);
      expected.writeUInt32LE(flags, index * 40 + 12);
    }
    expect(funcs.get('SendInput')).toHaveBeenCalledWith(4, expected, 40);
  });

  it('sends six events for ctrl-shift-v', () => {
    sendInputResult = 6;

    simulatePaste('ctrl-shift-v');

    expect(funcs.get('SendInput')).toHaveBeenCalledWith(6, expect.any(Buffer), 40);
  });
});
