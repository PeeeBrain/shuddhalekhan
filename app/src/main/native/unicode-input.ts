import koffi from 'koffi';
import {
  expectedUnicodeEventCount,
  interpretUnicodeDispatch,
  type UnicodeDispatchCertainty,
  type UnicodeDispatchRecovery,
} from '../../shared/live-dictation';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const INPUT_KEYBOARD = 1;
const INPUT_SIZE = 40;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;

const SendInput = user32.func(
  'uint32_t __stdcall SendInput(uint32_t cInputs, uint8_t * pInputs, int32_t cbSize)',
);
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()');

export interface UnicodeKeyboardInput {
  codeUnit: number;
  keyUp: boolean;
}

export interface UnicodeDispatchResult {
  acceptedEvents: number;
  expectedEvents: number;
  certainty: UnicodeDispatchCertainty;
  recovery: UnicodeDispatchRecovery;
  advanceCursor: boolean;
  errorCode?: number;
}

function keyboardInputBuffer(codeUnit: number, keyUp: boolean): Buffer {
  const input = Buffer.alloc(INPUT_SIZE);
  input.writeUInt32LE(INPUT_KEYBOARD, 0);
  input.writeUInt16LE(0, 8);
  input.writeUInt16LE(codeUnit, 10);
  input.writeUInt32LE(KEYEVENTF_UNICODE | (keyUp ? KEYEVENTF_KEYUP : 0), 12);
  return input;
}

export function buildUnicodeKeyboardInputs(text: string): UnicodeKeyboardInput[] {
  const events: UnicodeKeyboardInput[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    events.push({ codeUnit, keyUp: false }, { codeUnit, keyUp: true });
  }
  return events;
}

export type UnicodeDispatchFn = (text: string, expectedEvents: number) => Pick<
  UnicodeDispatchResult,
  'acceptedEvents' | 'errorCode'
>;

export function dispatchUnicodeText(
  text: string,
  dispatch?: UnicodeDispatchFn,
): UnicodeDispatchResult {
  const expectedEvents = expectedUnicodeEventCount(text);
  if (expectedEvents === 0) {
    return {
      acceptedEvents: 0,
      expectedEvents: 0,
      certainty: 'os-accepted-all',
      recovery: 'copy-only',
      advanceCursor: true,
    };
  }

  const { acceptedEvents, errorCode } = dispatch
    ? dispatch(text, expectedEvents)
    : sendUnicodeInputs(text);
  const interpretation = interpretUnicodeDispatch(acceptedEvents, expectedEvents, errorCode);
  return {
    acceptedEvents,
    expectedEvents,
    errorCode,
    ...interpretation,
  };
}

function sendUnicodeInputs(text: string): Pick<UnicodeDispatchResult, 'acceptedEvents' | 'errorCode'> {
  const inputs = buildUnicodeKeyboardInputs(text).map((event) =>
    keyboardInputBuffer(event.codeUnit, event.keyUp));
  const expectedEvents = inputs.length;
  const buffer = Buffer.concat(inputs);
  const acceptedEvents = Number(SendInput(expectedEvents, buffer, INPUT_SIZE));
  const errorCode = acceptedEvents < expectedEvents ? Number(GetLastError()) : undefined;
  return { acceptedEvents, errorCode };
}

export function sendUnicodeText(text: string): UnicodeDispatchResult {
  return dispatchUnicodeText(text);
}
