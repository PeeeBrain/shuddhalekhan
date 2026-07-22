import { beforeEach, describe, expect, it, mock } from 'bun:test';

const vi = { fn: mock };
let sendInputResult = 4;
let lastErrorCode = 0;
let clipboardSequenceNumber = 0;

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
          if (name === 'GetClipboardSequenceNumber') {
            return clipboardSequenceNumber;
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
  PasteDispatchResult,
  getClipboardSequenceNumber as GetClipboardSequenceNumber,
} from '../../native/clipboard';

describe('native clipboard paste dispatch', () => {
  let simulatePaste: typeof SimulatePaste;
  let getClipboardSequenceNumber: typeof GetClipboardSequenceNumber;

  beforeEach(async () => {
    sendInputResult = 4;
    lastErrorCode = 0;
    clipboardSequenceNumber = 0;
    funcs.clear();
    const mod = await import(`../../native/clipboard?test=${Date.now()}-${Math.random()}`);
    simulatePaste = mod.simulatePaste;
    getClipboardSequenceNumber = mod.getClipboardSequenceNumber;
  });

  it('returns full dispatch when all four events are accepted', () => {
    const result: PasteDispatchResult = simulatePaste();

    expect(funcs.get('SendInput')).toHaveBeenCalledWith(4, expect.any(Buffer), 40);
    expect(result.acceptedEvents).toBe(4);
  });

  it('returns zero accepted events when SendInput inserts nothing', () => {
    sendInputResult = 0;
    lastErrorCode = 5;

    const result = simulatePaste();

    expect(result.acceptedEvents).toBe(0);
    expect(result.errorCode).toBe(5);
  });

  it('returns partial accepted events with the Win32 error code', () => {
    sendInputResult = 2;
    lastErrorCode = 87;

    const result = simulatePaste();

    expect(result.acceptedEvents).toBe(2);
    expect(result.errorCode).toBe(87);
  });

  it('defaults to ctrl-v and sends four events', () => {
    const result = simulatePaste();

    expect(funcs.get('SendInput')).toHaveBeenCalledWith(4, expect.any(Buffer), 40);
    expect(result.acceptedEvents).toBe(4);
  });

  it('sends six events for ctrl-shift-v', () => {
    sendInputResult = 6;

    const result = simulatePaste('ctrl-shift-v');

    expect(funcs.get('SendInput')).toHaveBeenCalledWith(6, expect.any(Buffer), 40);
    expect(result.acceptedEvents).toBe(6);
  });

  it('reports partial dispatch for a six-event strategy', () => {
    sendInputResult = 5;
    lastErrorCode = 87;

    const result = simulatePaste('ctrl-shift-v');

    expect(result.acceptedEvents).toBe(5);
    expect(result.errorCode).toBe(87);
  });

  it('returns the current clipboard sequence number', () => {
    clipboardSequenceNumber = 42;

    const result = getClipboardSequenceNumber();

    expect(result).toBe(42);
  });
});
