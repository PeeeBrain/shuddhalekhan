import koffi from 'koffi';
import { captureForegroundTarget } from '../target';
import { interpretDispatch, type DispatchEvidence } from './state';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const INPUT_KEYBOARD = 1;
const INPUT_SIZE = 40;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;

const SendInput = user32.func(
  'uint32_t __stdcall SendInput(uint32_t cInputs, uint8_t * pInputs, int32_t cbSize)'
);
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()');

function keyboardInput(utf16CodeUnit: number, keyUp: boolean): Buffer {
  const input = Buffer.alloc(INPUT_SIZE);
  input.writeUInt32LE(INPUT_KEYBOARD, 0);
  input.writeUInt16LE(0, 8);
  input.writeUInt16LE(utf16CodeUnit, 10);
  input.writeUInt32LE(KEYEVENTF_UNICODE | (keyUp ? KEYEVENTF_KEYUP : 0), 12);
  return input;
}

export function dispatchUnicode(text: string): {
  evidence: DispatchEvidence;
  target: ReturnType<typeof captureForegroundTarget>;
} {
  const target = captureForegroundTarget();
  const utf16 = Buffer.from(text, 'utf16le');
  const events: Buffer[] = [];
  for (let offset = 0; offset < utf16.length; offset += 2) {
    const codeUnit = utf16.readUInt16LE(offset);
    events.push(keyboardInput(codeUnit, false), keyboardInput(codeUnit, true));
  }
  const inputs = Buffer.concat(events);
  const acceptedEvents = Number(SendInput(events.length, inputs, INPUT_SIZE));
  const errorCode = acceptedEvents < events.length ? Number(GetLastError()) : undefined;
  return {
    target,
    evidence: interpretDispatch(acceptedEvents, events.length, errorCode),
  };
}
