import { beforeEach, describe, expect, it, mock } from 'bun:test';

const vi = { fn: mock };
let sendInputResult = 4;
let lastErrorCode = 0;

const funcs = new Map<string, ReturnType<typeof vi.fn>>();
const impls = new Map<string, (...args: never[]) => unknown>();

mock.module('koffi', () => ({
  default: {
    load: vi.fn(() => ({
    func: vi.fn((signature: string) => {
      const name = signature.split('(')[0].trim().split(' ').pop() ?? signature;
      const fn = vi.fn((...args: unknown[]) => {
          const impl = impls.get(name);
          if (impl) {
            return impl(...(args as never[]));
          }
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
  writeTransientClipboardText as WriteTransientClipboardText,
} from '../../native/clipboard';

// The registered marker formats Windows reads; ids are arbitrary in the mock.
const HISTORY_FORMAT = 0xc001;
const CLOUD_FORMAT = 0xc002;
const CF_UNICODETEXT = 13;
const DWORD_ZERO = Buffer.alloc(4);

describe.skipIf(process.platform !== 'win32')('native transient clipboard write', () => {
  let writeTransientClipboardText: typeof WriteTransientClipboardText;
  let published: [number, Buffer][];
  let rejectFormat: number | null;
  let sequence: number;
  let openResults: number[];

  beforeEach(async () => {
    funcs.clear();
    impls.clear();
    lastErrorCode = 0;
    published = [];
    rejectFormat = null;
    sequence = 7;
    openResults = [];
    let open = false;
    const copied = new Map<object, Buffer>();
    const whileOpen = <T>(call: () => T) => {
      if (!open) throw new Error('clipboard used outside OpenClipboard/CloseClipboard');
      return call();
    };
    impls.set('RegisterClipboardFormatW', (name: string) =>
      ({ CanIncludeInClipboardHistory: HISTORY_FORMAT, CanUploadToCloudClipboard: CLOUD_FORMAT })[name] ?? 0);
    impls.set('CreateWindowExW', () => ({ owner: true }));
    impls.set('GetClipboardSequenceNumber', () => sequence);
    impls.set('OpenClipboard', () => {
      open = (openResults.shift() ?? 1) === 1;
      return Number(open);
    });
    impls.set('EmptyClipboard', () => whileOpen(() => 1));
    impls.set('CloseClipboard', () => whileOpen(() => {
      open = false;
      return 1;
    }));
    impls.set('GlobalAlloc', () => ({}));
    impls.set('GlobalLock', (memory: object) => memory);
    impls.set('RtlMoveMemory', (target: object, bytes: Buffer, length: number) => {
      copied.set(target, Buffer.from(bytes.subarray(0, length)));
    });
    impls.set('SetClipboardData', (format: number, memory: object) => whileOpen(() => {
      if (format === rejectFormat) return null;
      published.push([format, copied.get(memory) ?? Buffer.alloc(0)]);
      return memory;
    }));
    const mod = await import(`../../native/clipboard?test=${Date.now()}-${Math.random()}`);
    writeTransientClipboardText = mod.writeTransientClipboardText;
  });

  it('publishes the text with history and cloud exclusions in one owned clipboard transaction', () => {
    expect(writeTransientClipboardText('private words', 7)).toBe('staged');

    expect(published).toEqual([
      [HISTORY_FORMAT, DWORD_ZERO],
      [CLOUD_FORMAT, DWORD_ZERO],
      [CF_UNICODETEXT, Buffer.from('private words\0', 'utf16le')],
    ]);
    expect(funcs.get('OpenClipboard')).toHaveBeenCalledWith({ owner: true });
    expect(funcs.get('CloseClipboard')).toHaveBeenCalledTimes(1);
    expect(funcs.get('GlobalFree')).not.toHaveBeenCalled();
  });

  it('leaves a copy made while waiting for the clipboard untouched', () => {
    const open = impls.get('OpenClipboard');
    impls.set('OpenClipboard', (...args: never[]) => {
      sequence = 8;
      return open?.(...args);
    });

    expect(writeTransientClipboardText('private words', 7)).toBe('changed');

    expect(funcs.get('EmptyClipboard')).not.toHaveBeenCalled();
    expect(funcs.get('CloseClipboard')).toHaveBeenCalledTimes(1);
  });

  it('never publishes unmarked text when an exclusion cannot be set', () => {
    rejectFormat = CLOUD_FORMAT;

    expect(writeTransientClipboardText('private words', 7)).toBe('cleared');

    expect(published.map(([format]) => format)).not.toContain(CF_UNICODETEXT);
    expect(funcs.get('GlobalFree')).toHaveBeenCalledTimes(1);
    expect(funcs.get('CloseClipboard')).toHaveBeenCalledTimes(1);
  });

  it('waits briefly for another app to release the clipboard', () => {
    openResults = [0, 0, 1];

    expect(writeTransientClipboardText('private words', 7)).toBe('staged');
    expect(funcs.get('Sleep')).toHaveBeenCalledTimes(2);
  });

  it('gives up untouched when the clipboard stays locked', () => {
    openResults = [0, 0, 0, 0, 0];
    lastErrorCode = 5;

    expect(() => writeTransientClipboardText('private words', 7)).toThrow('OpenClipboard failed (Win32 error 5)');
    expect(funcs.get('EmptyClipboard')).not.toHaveBeenCalled();
    expect(funcs.get('CloseClipboard')).not.toHaveBeenCalled();
  });
});

// SendInput dispatch; native X11 dispatch has an isolated-server integration test.
describe.skipIf(process.platform !== 'win32')('native clipboard paste dispatch', () => {
  let simulatePaste: typeof SimulatePaste;

  beforeEach(async () => {
    sendInputResult = 4;
    lastErrorCode = 0;
    funcs.clear();
    impls.clear();
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
