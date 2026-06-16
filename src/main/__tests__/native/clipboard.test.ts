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

import type { simulatePaste as SimulatePaste, PasteDispatchResult } from '../../native/clipboard';

describe('native clipboard paste dispatch', () => {
  let simulatePaste: typeof SimulatePaste;

  beforeEach(async () => {
    sendInputResult = 4;
    lastErrorCode = 0;
    funcs.clear();
    const mod = await import(`../../native/clipboard?test=${Date.now()}-${Math.random()}`);
    simulatePaste = mod.simulatePaste;
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
});
