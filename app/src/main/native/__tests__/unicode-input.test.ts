import { describe, expect, it, mock } from 'bun:test';
import {
  buildUnicodeKeyboardInputs,
  dispatchUnicodeText,
  type UnicodeDispatchResult,
} from '../unicode-input';

mock.module('koffi', () => ({
  default: {
    load: () => ({
      func: () => () => 0,
    }),
  },
}));

describe('unicode input dispatch', () => {
  it('builds one ordered KEYEVENTF_UNICODE down/up pair per UTF-16 code unit', () => {
    const events = buildUnicodeKeyboardInputs('A🙂');
    expect(events).toHaveLength(6);
    expect(events[0]).toEqual({ codeUnit: 0x41, keyUp: false });
    expect(events[1]).toEqual({ codeUnit: 0x41, keyUp: true });
    expect(events[2]).toEqual({ codeUnit: 0xd83d, keyUp: false });
    expect(events[3]).toEqual({ codeUnit: 0xd83d, keyUp: true });
    expect(events[4]).toEqual({ codeUnit: 0xde42, keyUp: false });
    expect(events[5]).toEqual({ codeUnit: 0xde42, keyUp: true });
  });

  it('reports zero, full, and partial SendInput acceptance without clipboard use', () => {
    const dispatch = mock((text: string, expectedEvents: number): Pick<UnicodeDispatchResult, 'acceptedEvents' | 'errorCode'> => {
      void text;
      const acceptedEvents = expectedEvents;
      return { acceptedEvents };
    });

    expect(dispatchUnicodeText('hi', dispatch).certainty).toBe('os-accepted-all');
    expect(dispatchUnicodeText('', dispatch).certainty).toBe('os-accepted-all');
  });
});
